import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;

/** A keyed stream processor: two joins and a windowed count. */
public class StreamJoins {
    /** An impression and a click for the same ad, close in time. */
    public record Joined(int ad, int impression, int click) {}

    /** The number of views in one tumbling window. */
    public record Count(int start, int end, int views) {}

    /** An order with the user's country added, or null. */
    public record Enriched(int user, String country) {}

    private final int window; // most ticks from impression to click
    private final int lateness; // ticks late events are still used
    private final int size; // length of a tumbling window
    private int wm; // watermark: events before it are late
    // side -> ad -> event times, in time order
    private final Map<Character, TreeMap<Integer, List<Integer>>> state =
        Map.of('i', new TreeMap<>(), 'c', new TreeMap<>());
    private final Map<Integer, String> table = new HashMap<>();
    private final TreeMap<Integer, Integer> counts = new TreeMap<>();
    private final Set<Integer> fired = new HashSet<>();
    final List<Object> out = new ArrayList<>();
    final List<String> sideOut = new ArrayList<>();

    public StreamJoins(int window, int lateness, int size) {
        this.window = window;
        this.lateness = lateness;
        this.size = size;
    }

    // region stream_stream
    /** An impression ('i') or a click ('c') for one ad. */
    public int onEvent(char side, int ad, int t) { //@arrive
        if (t < wm) { //@late_test
            if (t < wm - lateness) { //@lateness_test
                sideOut.add(side + "" + ad + "@" + t); //@side
                return 0; //@side
            }
        }
        List<Integer> mine = state.get(side)
            .computeIfAbsent(ad, k -> new ArrayList<>());
        mine.add(t); //@store
        mine.sort(null); //@store
        char other = side == 'i' ? 'c' : 'i';
        int joined = 0;
        var theirs = state.get(other).getOrDefault(ad, List.of());
        for (int u : theirs) { //@probe
            int imp = side == 'i' ? t : u;
            int click = side == 'c' ? t : u;
            if (click - imp >= 0 && click - imp <= window) { //@in_window
                out.add(new Joined(ad, imp, click)); //@emit
                joined++; //@emit
            }
        }
        return joined; //@done
    }
    // endregion

    // region expire
    /** Moves the watermark on, then cleans up behind it. */
    public int advance(int ticks) { //@advance
        wm += ticks; //@advance
        int keep = wm - window - lateness; //@horizon
        int dropped = 0;
        for (char side : new char[] {'i', 'c'}) {
            TreeMap<Integer, List<Integer>> byAd = state.get(side);
            for (int ad : new ArrayList<>(byAd.keySet())) {
                List<Integer> times = byAd.get(ad);
                while (!times.isEmpty() && times.get(0) < keep) { //@expire_test
                    times.remove(0); //@drop
                    dropped++; //@drop
                }
                if (times.isEmpty()) {
                    byAd.remove(ad);
                }
            }
        }
        closeWindows(); //@close
        return dropped; //@done
    }
    // endregion

    // region close
    /** Emits each window the watermark has passed. */
    private void closeWindows() {
        for (int start : new ArrayList<>(counts.keySet())) {
            int end = start + size;
            if (end > wm) { //@open_test
                break; //@open_test
            }
            if (fired.add(start)) { //@fire
                out.add(new Count(start, end, counts.get(start))); //@fire
            }
            if (end + lateness <= wm) { //@purge_test
                counts.remove(start); //@purge
                fired.remove(start); //@purge
            }
        }
    }
    // endregion

    // region window
    /** Counts one page view in the window its time falls in. */
    public int onView(int t) { //@arrive
        int start = t - t % size; //@assign
        int end = start + size; //@assign
        if (end + lateness <= wm) { //@kept_test
            sideOut.add("v@" + t); //@side
            return -1; //@side
        }
        int n = counts.merge(start, 1, Integer::sum); //@count
        if (end <= wm) { //@closed_test
            fired.add(start); //@refire
            out.add(new Count(start, end, n)); //@refire
        }
        return start; //@done
    }
    // endregion

    // region cdc
    /** A change event from the profiles database. */
    public String onChange(int user, String country) { //@arrive
        return table.put(user, country); //@upsert,done
    }
    // endregion

    // region stream_table
    /** Enriches an order with the user's country, if known. */
    public String onOrder(int user) { //@arrive
        String country = table.get(user); //@lookup
        // A left join: with no profile, country is null.
        out.add(new Enriched(user, country)); //@enrich
        return country; //@done
    }
    // endregion

    int watermark() {
        return wm;
    }

    Map<Integer, List<Integer>> stateOf(char side) {
        return state.get(side);
    }

    Map<Integer, String> table() {
        return table;
    }
}
