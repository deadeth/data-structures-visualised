class StreamJoins:
    """A keyed stream processor: two joins and a windowed count."""

    def __init__(self, window=3, lateness=2, size=4):
        self.window = window  # most ticks from impression to click
        self.lateness = lateness  # ticks late events are still used
        self.size = size  # length of a tumbling window
        self.wm = 0  # watermark: events before it are late
        self.state = {"i": {}, "c": {}}  # side -> ad -> times
        self.table = {}  # user -> country, a local copy
        self.counts = {}  # window start -> views counted
        self.fired = set()  # windows already emitted
        self.out = []  # the output stream
        self.side_out = []  # events too late to use

    # region stream_stream
    def on_event(self, side, ad, t):  #@arrive
        """An impression ("i") or a click ("c") for one ad."""
        if t < self.wm:  #@late_test
            if t < self.wm - self.lateness:  #@lateness_test
                self.side_out.append(f"{side}{ad}@{t}")  #@side
                return 0  #@side
        mine = self.state[side].setdefault(ad, [])
        mine.append(t)  #@store
        mine.sort()  #@store
        other = "c" if side == "i" else "i"
        joined = 0
        for u in self.state[other].get(ad, []):  #@probe
            imp, click = (t, u) if side == "i" else (u, t)
            if 0 <= click - imp <= self.window:  #@in_window
                self.out.append(("join", ad, imp, click))  #@emit
                joined += 1  #@emit
        return joined  #@done
    # endregion

    # region expire
    def advance(self, ticks):  #@advance
        """Move the watermark on, then clean up behind it."""
        self.wm += ticks  #@advance
        keep = self.wm - self.window - self.lateness  #@horizon
        dropped = 0
        for side in ("i", "c"):
            by_ad = self.state[side]
            for ad in sorted(by_ad):
                times = by_ad[ad]  # kept in time order
                while times and times[0] < keep:  #@expire_test
                    times.pop(0)  #@drop
                    dropped += 1  #@drop
                if not times:
                    del by_ad[ad]
        self.close_windows()  #@close
        return dropped  #@done
    # endregion

    # region close
    def close_windows(self):
        """Emit each window the watermark has passed."""
        for start in sorted(self.counts):
            end = start + self.size
            if end > self.wm:  #@open_test
                break  #@open_test
            if start not in self.fired:
                self.fired.add(start)  #@fire
                n = self.counts[start]  #@fire
                self.out.append(("count", start, end, n))  #@fire
            if end + self.lateness <= self.wm:  #@purge_test
                del self.counts[start]  #@purge
                self.fired.discard(start)  #@purge
    # endregion

    # region window
    def on_view(self, t):  #@arrive
        """Count one page view in the window its time falls in."""
        start = t - t % self.size  #@assign
        end = start + self.size  #@assign
        if end + self.lateness <= self.wm:  #@kept_test
            self.side_out.append(f"v@{t}")  #@side
            return None  #@side
        n = self.counts.get(start, 0) + 1  #@count
        self.counts[start] = n  #@count
        if end <= self.wm:  #@closed_test
            self.fired.add(start)  #@refire
            self.out.append(("count", start, end, n))  #@refire
        return start  #@done
    # endregion

    # region cdc
    def on_change(self, user, country):  #@arrive
        """A change event from the profiles database."""
        old = self.table.get(user)
        self.table[user] = country  #@upsert
        return old  #@done
    # endregion

    # region stream_table
    def on_order(self, user):  #@arrive
        """Enrich an order with the user's country, if known."""
        country = self.table.get(user)  #@lookup
        # A left join: with no profile, country is None.
        self.out.append(("order", user, country))  #@enrich
        return country  #@done
    # endregion
