import heapq
import math
from collections import deque


# region graph
class Graph:
    """Undirected, weighted, kept as adjacency lists."""

    def __init__(self):
        self.adj = {}  # node -> [(neighbour, weight)]

    def add_edge(self, a, b, weight):
        for u, v in ((a, b), (b, a)):  # both directions
            edges = self.adj.setdefault(u, [])
            edges.append((v, weight))
            edges.sort()  # keeps neighbours A to Z
    # endregion

    # region bfs
    def bfs(self, start):  #@call
        """Visit every reachable node, nearest first."""
        seen = {start}  #@begin
        queue = deque([start])  #@begin
        order = []
        while queue:
            u = queue.popleft()  #@take
            order.append(u)  #@take
            # Weights play no part here.
            for v, _ in self.adj[u]:
                if v not in seen:  #@check
                    seen.add(v)  #@enqueue
                    queue.append(v)  #@enqueue
        return order  #@done
    # endregion

    # region dfs
    def dfs(self, start):  #@call
        """Visit every reachable node, deep before wide."""
        visited = set()
        stack = [start]  #@begin
        order = []
        while stack:
            u = stack.pop()  #@pop
            if u in visited:  #@stale
                continue  # out of date: u has been visited  #@stale
            visited.add(u)  #@visit
            order.append(u)  #@visit
            # Reversed, so the first neighbour ends on top.
            for v, _ in reversed(self.adj[u]):
                if v not in visited:  #@check
                    stack.append(v)  #@push
            if len(order) == len(self.adj):  #@all_visited
                break  # the rest of the stack is out of date  #@all_visited
        return order  #@done
    # endregion

    # region dijkstra
    def dijkstra(self, source, target):  #@call
        """Cheapest route as (path, cost), or None."""
        dist = {source: 0}  #@begin
        parent = {}
        settled = set()
        # (distance, node): ties come out A before B.
        heap = [(0, source)]  #@begin
        while heap:
            d, u = heapq.heappop(heap)  #@pop
            if u in settled:  #@stale
                continue  # an older, longer entry for u  #@stale
            settled.add(u)  # d is final for u  #@settle
            if u == target:  #@target
                break  #@target
            for v, weight in self.adj[u]:
                candidate = d + weight  #@relax
                if candidate < dist.get(v, math.inf):  #@relax
                    dist[v] = candidate  #@improve
                    parent[v] = u  #@improve
                    heapq.heappush(heap, (candidate, v))  #@improve
        if target not in settled:
            return None  #@unreachable
        path = [target]
        while path[-1] != source:  #@trace
            path.append(parent[path[-1]])  #@trace
        path.reverse()
        return path, dist[target]  #@done
    # endregion
