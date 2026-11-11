import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;

/** Immutable segments plus an in-memory buffer, as in Lucene. */
public class InvertedIndex {
    static final Set<String> STOP_WORDS = Set.of("a", "and", "the");

    /** One entry of a postings list: a document and how often it has the term. */
    public record Posting(int doc, int tf) {}

    /** An immutable segment: sorted terms, their postings, a live-docs set. */
    public static final class Segment {
        final List<String> terms; // sorted
        final Map<String, List<Posting>> postings; // by doc
        final List<Integer> docs; // sorted
        final Set<Integer> deleted = new HashSet<>(); // tombstones

        Segment(List<String> terms, Map<String, List<Posting>> postings,
                List<Integer> docs) {
            this.terms = terms;
            this.postings = postings;
            this.docs = docs;
        }

        boolean isLive(int doc) {
            return !deleted.contains(doc);
        }

        // region lookup
        /** Binary search of the sorted term dictionary. */
        List<Posting> lookup(String term) {
            int lo = 0, hi = terms.size() - 1; //@lo_hi
            while (lo <= hi) {
                int mid = (lo + hi) / 2; //@mid
                int c = term.compareTo(terms.get(mid)); //@test
                if (c < 0) { //@test
                    hi = mid - 1; //@go_left
                } else if (c > 0) { //@test_more
                    lo = mid + 1; //@go_right
                } else {
                    return postings.get(term); //@found
                }
            }
            return List.of(); //@missing
        }
        // endregion

        // region live_postings
        /** The postings of term without deleted documents. */
        List<Posting> live(String term) {
            List<Posting> out = new ArrayList<>();
            for (Posting p : postings.get(term)) {
                if (isLive(p.doc())) { //@drop
                    out.add(p); //@drop
                }
            }
            return out;
        }
        // endregion
    }

    final List<Segment> segments = new ArrayList<>(); // oldest first
    // term -> [doc, tf] pairs, in arrival order
    Map<String, List<int[]>> buffer = new LinkedHashMap<>();
    List<Integer> buffered = new ArrayList<>(); // doc ids in the buffer

    boolean holds(int doc) {
        if (buffered.contains(doc)) {
            return true;
        }
        for (Segment seg : segments) {
            if (seg.docs.contains(doc)) {
                return true;
            }
        }
        return false;
    }

    // region index
    /** Analyses text and adds its terms to the buffer. */
    public boolean index(int doc, String text) {
        if (holds(doc)) { //@known_test
            return false; //@known
        }
        buffered.add(doc); //@start
        for (String word : text.split(" ")) { //@token
            String term = word.toLowerCase(); //@lower
            if (STOP_WORDS.contains(term)) {
                continue; //@stop
            }
            List<int[]> postings =
                buffer.computeIfAbsent(term, t -> new ArrayList<>()); //@add
            int[] last = postings.isEmpty() ? null : postings.getLast();
            if (last != null && last[0] == doc) {
                last[1]++; //@tf
            } else {
                postings.add(new int[] {doc, 1}); //@posting
            }
        }
        return true; //@done
    }
    // endregion

    // region flush
    /** Sorts the buffer and writes it out as a new segment. */
    public Segment flush() {
        if (buffered.isEmpty()) {
            return null; //@empty
        }
        List<String> terms = new ArrayList<>(new TreeSet<>(buffer.keySet())); //@sort
        Map<String, List<Posting>> postings = new LinkedHashMap<>();
        for (String t : terms) {
            List<Posting> list = new ArrayList<>(); //@sort
            for (int[] p : buffer.get(t)) {
                list.add(new Posting(p[0], p[1])); //@sort
            }
            list.sort(Comparator.comparingInt(Posting::doc)); //@sort
            postings.put(t, list);
        }
        List<Integer> docs = new ArrayList<>(new TreeSet<>(buffered));
        Segment seg = new Segment(terms, postings, docs); //@write
        segments.add(seg); //@publish
        buffer = new LinkedHashMap<>(); //@publish
        buffered = new ArrayList<>(); //@publish
        return seg;
    }
    // endregion

    // region search
    /** Live documents that hold term. */
    public List<Integer> search(String term) {
        if (STOP_WORDS.contains(term)) { //@search_start
            return List.of(); //@stop_query
        }
        List<Integer> hits = new ArrayList<>();
        for (Segment seg : segments) { //@segment
            for (Posting p : seg.lookup(term)) { //@postings
                if (seg.isLive(p.doc())) { //@live
                    hits.add(p.doc()); //@hit
                }
            }
        }
        return hits; //@hits
    }
    // endregion

    // region and
    /** Live documents that hold both terms. */
    public List<Integer> searchAnd(String a, String b) {
        List<Integer> hits = new ArrayList<>();
        for (Segment seg : segments) { //@and_segment
            List<Posting> xs = seg.lookup(a); //@and_lookup
            List<Posting> ys = seg.lookup(b); //@and_lookup
            int i = 0, j = 0;
            while (i < xs.size() && j < ys.size()) { //@walk
                int x = xs.get(i).doc(), y = ys.get(j).doc();
                if (x == y) { //@cmp
                    if (seg.isLive(x)) { //@and_live
                        hits.add(x); //@match
                    }
                    i++; //@advance
                    j++; //@advance
                } else if (x < y) { //@cmp_less
                    i++; //@skip_a
                } else {
                    j++; //@skip_b
                }
            }
        }
        return hits; //@and_done
    }
    // endregion

    // region or
    /** Live documents that hold either term. */
    public List<Integer> searchOr(String a, String b) {
        List<Integer> hits = new ArrayList<>();
        for (Segment seg : segments) { //@or_segment
            List<Posting> xs = seg.lookup(a); //@or_lookup
            List<Posting> ys = seg.lookup(b); //@or_lookup
            int i = 0, j = 0;
            List<Integer> out = new ArrayList<>();
            while (i < xs.size() && j < ys.size()) { //@or_walk
                int x = xs.get(i).doc(), y = ys.get(j).doc();
                if (x == y) { //@or_cmp
                    out.add(x); //@or_both
                    i++; //@or_both
                    j++; //@or_both
                } else if (x < y) { //@or_less
                    out.add(x); //@take_x
                    i++; //@take_x
                } else {
                    out.add(y); //@take_y
                    j++; //@take_y
                }
            }
            for (; i < xs.size(); i++) out.add(xs.get(i).doc()); //@rest
            for (; j < ys.size(); j++) out.add(ys.get(j).doc()); //@rest
            for (int d : out) {
                if (seg.isLive(d)) hits.add(d); //@or_live
            }
        }
        return hits; //@or_done
    }
    // endregion

    // region delete
    /** Marks doc deleted with a tombstone. Nothing is rewritten. */
    public boolean delete(int doc) {
        for (Segment seg : segments) { //@find
            if (seg.docs.contains(doc) && seg.isLive(doc)) { //@find_test
                seg.deleted.add(doc); //@tombstone
                return true; //@tombstone
            }
        }
        return false; //@not_found
    }
    // endregion

    // region merge
    /** Merges segments k and k + 1, leaving deleted docs behind. */
    public Segment merge(int k) {
        Segment a = segments.get(k), b = segments.get(k + 1); //@merge_start
        List<String> terms = new ArrayList<>();
        Map<String, List<Posting>> postings = new LinkedHashMap<>();
        int i = 0, j = 0;
        while (i < a.terms.size() || j < b.terms.size()) { //@merge_walk
            String ta = i < a.terms.size() ? a.terms.get(i) : null;
            String tb = j < b.terms.size() ? b.terms.get(j) : null;
            String term;
            List<Posting> docs;
            if (tb == null || (ta != null && ta.compareTo(tb) < 0)) { //@merge_cmp
                term = ta; //@take_a
                docs = a.live(ta); //@take_a
                i++;
            } else if (ta == null || tb.compareTo(ta) < 0) { //@merge_cmp_more
                term = tb; //@take_b
                docs = b.live(tb); //@take_b
                j++;
            } else {
                term = ta; //@same
                docs = a.live(ta); //@same
                docs.addAll(b.live(tb)); //@same
                // Lucene renumbers the documents, so it only appends.
                docs.sort(Comparator.comparingInt(Posting::doc)); //@same
                i++;
                j++;
            }
            if (!docs.isEmpty()) { //@keep
                terms.add(term); //@keep
                postings.put(term, docs); //@keep
            }
        }
        TreeSet<Integer> live = new TreeSet<>();
        for (Segment s : List.of(a, b)) {
            for (int d : s.docs) {
                if (s.isLive(d)) live.add(d);
            }
        }
        Segment merged = new Segment(terms, postings, new ArrayList<>(live)); //@replace
        segments.remove(k + 1); //@replace
        if (live.isEmpty()) {
            segments.remove(k); //@replace
        } else {
            segments.set(k, merged); //@replace
        }
        return merged;
    }
    // endregion

    // region rank
    /** Live documents holding a or b, best tf-idf score first. */
    public List<Integer> rank(String a, String b) {
        int n = 0;
        for (Segment s : segments) {
            n += s.docs.size() - s.deleted.size(); //@count
        }
        Map<String, Map<Integer, Integer>> tfs = new LinkedHashMap<>();
        for (String term : new LinkedHashSet<>(List.of(a, b))) {
            Map<Integer, Integer> found = new LinkedHashMap<>();
            tfs.put(term, found);
            for (Segment seg : segments) { //@gather
                for (Posting p : seg.lookup(term)) { //@gather
                    if (seg.isLive(p.doc())) { //@gather
                        found.put(p.doc(), p.tf()); //@gather
                    }
                }
            }
        }
        Map<String, Double> idf = new LinkedHashMap<>();
        for (var e : tfs.entrySet()) {
            int df = e.getValue().size();
            if (df > 0) idf.put(e.getKey(), Math.log10((double) n / df)); //@idf
        }
        TreeSet<Integer> matched = new TreeSet<>();
        for (Map<Integer, Integer> found : tfs.values()) {
            matched.addAll(found.keySet());
        }
        Map<Integer, Double> scores = new LinkedHashMap<>();
        for (int doc : matched) { //@score
            double score = 0;
            for (var e : idf.entrySet()) {
                int tf = tfs.get(e.getKey()).getOrDefault(doc, 0);
                score += tf * e.getValue(); //@score
            }
            scores.put(doc, score);
        }
        List<Integer> best = new ArrayList<>(matched);
        best.sort(Comparator.comparingDouble((Integer d) -> -scores.get(d))
            .thenComparingInt(d -> d)); //@sort
        return best;
    }
    // endregion
}
