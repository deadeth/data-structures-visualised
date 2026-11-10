import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.Deque;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedList;
import java.util.List;
import java.util.Map;
import java.util.PriorityQueue;
import java.util.Set;

public class Graph {
    private static final int INFINITY = Integer.MAX_VALUE;

    // region graph
    record Edge(String to, int weight) {}

    /** Each node's edges, neighbours in A to Z order. */
    private final Map<String, List<Edge>> adj = new HashMap<>();

    public void addEdge(String a, String b, int weight) {
        link(a, b, weight);
        link(b, a, weight); // both directions
    }

    private void link(String from, String to, int weight) {
        List<Edge> edges =
            adj.computeIfAbsent(from, k -> new ArrayList<>());
        edges.add(new Edge(to, weight));
        edges.sort(Comparator.comparing(Edge::to));
    }
    // endregion

    // region bfs
    /** Visit every reachable node, nearest first. */
    public List<String> bfs(String start) { //@call
        Set<String> seen = new HashSet<>();
        Deque<String> queue = new ArrayDeque<>();
        List<String> order = new ArrayList<>();
        seen.add(start); //@begin
        queue.add(start); //@begin
        while (!queue.isEmpty()) {
            String u = queue.remove(); //@take
            order.add(u); //@take
            // Weights play no part here.
            for (Edge edge : adj.get(u)) {
                if (!seen.contains(edge.to())) { //@check
                    seen.add(edge.to()); //@enqueue
                    queue.add(edge.to()); //@enqueue
                }
            }
        }
        return order; //@done
    }
    // endregion

    // region dfs
    /** Visit every reachable node, deep before wide. */
    public List<String> dfs(String start) { //@call
        Set<String> visited = new HashSet<>();
        Deque<String> stack = new ArrayDeque<>();
        List<String> order = new ArrayList<>();
        stack.push(start); //@begin
        while (!stack.isEmpty()) {
            String u = stack.pop(); //@pop
            if (visited.contains(u)) { //@stale
                continue; // out of date: u has been visited //@stale
            }
            visited.add(u); //@visit
            order.add(u); //@visit
            // Reversed, so the first neighbour ends on top.
            for (Edge edge : adj.get(u).reversed()) {
                if (!visited.contains(edge.to())) { //@check
                    stack.push(edge.to()); //@push
                }
            }
            if (order.size() == adj.size()) { //@all_visited
                break; // the rest of the stack is out of date //@all_visited
            }
        }
        return order; //@done
    }
    // endregion

    // region dijkstra
    record Entry(int dist, String node) {}

    record Route(List<String> path, int cost) {}

    /** Cheapest route from source to target, or null. */
    public Route dijkstra(String source, String target) { //@call
        Map<String, Integer> dist = new HashMap<>();
        Map<String, String> parent = new HashMap<>();
        Set<String> settled = new HashSet<>();
        // Smallest distance first; ties come out A before B.
        PriorityQueue<Entry> heap = new PriorityQueue<>(
            Comparator.comparingInt(Entry::dist)
                .thenComparing(Entry::node));
        dist.put(source, 0); //@begin
        heap.add(new Entry(0, source)); //@begin
        while (!heap.isEmpty()) {
            Entry top = heap.poll(); //@pop
            String u = top.node();
            if (settled.contains(u)) { //@stale
                continue; // an older, longer entry for u //@stale
            }
            settled.add(u); // top.dist() is final for u //@settle
            if (u.equals(target)) { //@target
                break; //@target
            }
            for (Edge edge : adj.get(u)) {
                String v = edge.to();
                int candidate = top.dist() + edge.weight(); //@relax
                int best = dist.getOrDefault(v, INFINITY);
                if (candidate < best) { //@relax
                    dist.put(v, candidate); //@improve
                    parent.put(v, u); //@improve
                    heap.add(new Entry(candidate, v)); //@improve
                }
            }
        }
        if (!settled.contains(target)) {
            return null; //@unreachable
        }
        LinkedList<String> path = new LinkedList<>();
        for (String v = target; v != null; v = parent.get(v)) { //@trace
            path.addFirst(v); //@trace
        }
        return new Route(path, dist.get(target)); //@done
    }
    // endregion
}
