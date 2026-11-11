import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/** Mercator-style frontier: priority in front, one host per back queue. */
public class CrawlFrontier {
    int clock; // ticks; a real crawler reads the wall clock
    final int delay; // ticks between two requests to one host
    final List<ArrayDeque<String>> front = new ArrayList<>(); // high first
    final List<ArrayDeque<String>> back = new ArrayList<>();
    final String[] host; // the host each back queue serves
    final Map<String, Integer> table = new HashMap<>(); // host -> back queue
    final Map<String, Integer> ready = new HashMap<>(); // host -> next tick
    final List<int[]> heap = new ArrayList<>(); // {ready tick, back queue}
    final Map<String, Integer> pending = new HashMap<>(); // host -> queued
    final int frontCap;
    final int hostCap;

    public CrawlFrontier(int backQueues, int delay, int frontCap, int hostCap) {
        this.delay = delay;
        this.frontCap = frontCap;
        this.hostCap = hostCap;
        this.host = new String[backQueues];
        for (int p = 0; p < 3; p++) {
            front.add(new ArrayDeque<>());
        }
        for (int q = 0; q < backQueues; q++) {
            back.add(new ArrayDeque<>());
        }
    }

    /** "a/1" is short for http://a.example/1: the host is the part before /. */
    static String hostOf(String url) {
        return url.substring(0, url.indexOf('/'));
    }

    // region add
    /** Queue url by priority alone: 0 high, 1 normal, 2 low. */
    public boolean add(String url, int priority) {
        ArrayDeque<String> queue = front.get(priority); //@check
        int waiting = pending.getOrDefault(hostOf(url), 0); //@check
        if (queue.size() >= frontCap || waiting >= hostCap) {
            return false; // bounded: the caller backs off //@full
        }
        queue.addLast(url); //@append
        pending.put(hostOf(url), waiting + 1); //@append
        return true; //@added
    }
    // endregion

    // region next
    /** Lease the next URL that is polite to fetch, or null. */
    public String next() {
        for (int q = 0; q < back.size(); q++) {
            if (host[q] == null) { // idle: try to give it a host
                refill(q); //@idle
            }
        }
        if (heap.isEmpty()) {
            return null; //@none
        }
        int due = heap.get(0)[0]; //@peek
        int q = heap.get(0)[1]; //@peek
        if (due > clock) { //@due
            return null; // wait due - clock ticks //@wait
        }
        pop(); //@pop
        String h = host[q];
        String url = back.get(q).pollFirst(); //@lease
        pending.merge(h, -1, Integer::sum); //@lease
        ready.put(h, clock + delay); //@ready
        if (!back.get(q).isEmpty()) {
            push(ready.get(h), q); //@again
        } else {
            table.remove(h); //@release
            host[q] = null; //@release
            refill(q); //@refill
        }
        return url; //@done
    }
    // endregion

    // region refill
    /** Pull from the front queues until back queue q has a host. */
    private void refill(int q) {
        while (true) {
            String url = pull(); //@pull
            if (url == null) {
                return; // q stays idle, off the heap //@dry
            }
            String h = hostOf(url);
            Integer owner = table.get(h); //@lookup
            if (owner != null) { //@lookup
                back.get(owner).addLast(url); //@route
            } else {
                table.put(h, q); //@claim
                host[q] = h; //@claim
                back.get(q).addLast(url); //@claim
                // A host never contacted is allowed at once.
                push(ready.getOrDefault(h, clock), q); //@schedule
                return;
            }
        }
    }

    /** Head of the first front queue that has one, high first. */
    private String pull() {
        // Mercator picks at random, biased to high, so low never starves.
        for (ArrayDeque<String> queue : front) {
            if (!queue.isEmpty()) {
                return queue.pollFirst();
            }
        }
        return null;
    }
    // endregion

    // region heap_push
    /** Add {due, q}, then swap it up while its parent is later. */
    private void push(int due, int q) {
        heap.add(new int[] {due, q}); //@push
        int i = heap.size() - 1;
        while (i > 0) {
            int parent = (i - 1) / 2;
            if (heap.get(i)[0] >= heap.get(parent)[0]) { //@compare_up
                break; //@stop_up
            }
            swap(i, parent); //@swap_up
            i = parent; //@swap_up
        }
    }
    // endregion

    // region heap_pop
    /** Remove the root. The last entry fills the hole and sifts down. */
    private void pop() {
        int[] last = heap.remove(heap.size() - 1); //@take_root
        if (heap.isEmpty()) {
            return;
        }
        heap.set(0, last); //@take_root
        int i = 0;
        int n = heap.size();
        while (true) {
            int child = 2 * i + 1;
            if (child >= n) {
                break;
            }
            int right = child + 1;
            if (right < n && heap.get(right)[0] < heap.get(child)[0]) { //@pick
                child = right; //@pick_right
            }
            if (heap.get(i)[0] <= heap.get(child)[0]) { //@compare_down
                break; //@stop_down
            }
            swap(i, child); //@swap_down
            i = child; //@swap_down
        }
    }

    private void swap(int i, int j) {
        int[] held = heap.get(i);
        heap.set(i, heap.get(j));
        heap.set(j, held);
    }
    // endregion

    // region tick
    /** Time passes. Nothing moves until next is called. */
    public int tick(int ticks) {
        clock += ticks; //@tick
        return clock; //@ticked
    }
    // endregion
}
