from collections import deque


def host_of(url):
    """'a/1' is short for http://a.example/1: the host is the part before /."""
    return url.split("/")[0]


class CrawlFrontier:
    """Mercator-style frontier: priority in front, one host per back queue."""

    def __init__(self, back_queues=3, delay=3, front_cap=4, host_cap=4):
        self.clock = 0  # ticks; a real crawler reads the wall clock
        self.delay = delay  # ticks between two requests to one host
        self.front = [deque(), deque(), deque()]  # high, normal, low
        self.back = [deque() for _ in range(back_queues)]
        self.host = [None] * back_queues  # the host each back queue serves
        self.table = {}  # host -> index of its back queue
        self.ready = {}  # host -> first tick it may be contacted again
        self.heap = []  # [ready tick, back queue], soonest at index 0
        self.pending = {}  # host -> URLs queued and not yet leased
        self.front_cap = front_cap
        self.host_cap = host_cap

    # region add
    def add(self, url, priority):
        """Queue url by priority alone: 0 high, 1 normal, 2 low."""
        queue = self.front[priority]  #@check
        waiting = self.pending.get(host_of(url), 0)  #@check
        if len(queue) >= self.front_cap or waiting >= self.host_cap:
            return False  # bounded: the caller backs off  #@full
        queue.append(url)  #@append
        self.pending[host_of(url)] = waiting + 1  #@append
        return True  #@added
    # endregion

    # region next
    def next(self):
        """Lease the next URL that is polite to fetch, or None."""
        for q in range(len(self.back)):
            if self.host[q] is None:  # idle: try to give it a host
                self._refill(q)  #@idle
        if not self.heap:
            return None  #@none
        due, q = self.heap[0]  #@peek
        if due > self.clock:  #@due
            return None  # wait due - clock ticks  #@wait
        self._pop()  #@pop
        host = self.host[q]
        url = self.back[q].popleft()  #@lease
        self.pending[host] -= 1  #@lease
        self.ready[host] = self.clock + self.delay  #@ready
        if self.back[q]:
            self._push(self.ready[host], q)  #@again
        else:
            del self.table[host]  #@release
            self.host[q] = None  #@release
            self._refill(q)  #@refill
        return url  #@done
    # endregion

    # region refill
    def _refill(self, q):
        """Pull from the front queues until back queue q has a host."""
        while True:
            url = self._pull()  #@pull
            if url is None:
                return  # q stays idle, off the heap  #@dry
            host = host_of(url)
            if host in self.table:  #@lookup
                self.back[self.table[host]].append(url)  #@route
            else:
                self.table[host] = q  #@claim
                self.host[q] = host  #@claim
                self.back[q].append(url)  #@claim
                # A host never contacted is allowed at once.
                self._push(self.ready.get(host, self.clock), q)  #@schedule
                return

    def _pull(self):
        """Head of the first front queue that has one, high first."""
        # Mercator picks at random, biased to high, so low never starves.
        for queue in self.front:
            if queue:
                return queue.popleft()
        return None
    # endregion

    # region heap_push
    def _push(self, due, q):
        """Add [due, q], then swap it up while its parent is later."""
        heap = self.heap
        heap.append([due, q])  #@push
        i = len(heap) - 1
        while i > 0:
            parent = (i - 1) // 2
            if heap[i][0] >= heap[parent][0]:  #@compare_up
                break  #@stop_up
            heap[i], heap[parent] = heap[parent], heap[i]  #@swap_up
            i = parent  #@swap_up
    # endregion

    # region heap_pop
    def _pop(self):
        """Remove the root. The last entry fills the hole and sifts down."""
        heap = self.heap
        last = heap.pop()  #@take_root
        if not heap:
            return
        heap[0] = last  #@take_root
        i, n = 0, len(heap)
        while True:
            child = 2 * i + 1
            if child >= n:
                break
            right = child + 1
            if right < n and heap[right][0] < heap[child][0]:  #@pick
                child = right  #@pick_right
            if heap[i][0] <= heap[child][0]:  #@compare_down
                break  #@stop_down
            heap[i], heap[child] = heap[child], heap[i]  #@swap_down
            i = child  #@swap_down
    # endregion

    # region tick
    def tick(self, ticks=1):
        """Time passes. Nothing moves until next is called."""
        self.clock += ticks  #@tick
        return self.clock  #@ticked
    # endregion
