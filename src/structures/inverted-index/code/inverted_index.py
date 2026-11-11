import math

STOP_WORDS = {"a", "and", "the"}


class Segment:
    """An immutable segment: sorted terms, their postings, a live-docs set."""

    def __init__(self, terms, postings, docs):
        self.terms = terms  # sorted
        self.postings = postings  # term -> [(doc, tf)], by doc
        self.docs = docs  # sorted doc ids
        self.deleted = set()  # tombstones

    def is_live(self, doc):
        return doc not in self.deleted

    # region lookup
    def lookup(self, term):
        """Binary search of the sorted term dictionary."""
        lo, hi = 0, len(self.terms) - 1  #@lo_hi
        while lo <= hi:
            mid = (lo + hi) // 2  #@mid
            if term < self.terms[mid]:  #@test
                hi = mid - 1  #@go_left
            elif term > self.terms[mid]:  #@test_more
                lo = mid + 1  #@go_right
            else:
                return self.postings[term]  #@found
        return []  #@missing
    # endregion

    # region live_postings
    def live(self, term):
        """The postings of term without deleted documents."""
        return [p for p in self.postings[term] if self.is_live(p[0])]  #@drop
    # endregion


class InvertedIndex:
    """Immutable segments plus an in-memory buffer, as in Lucene."""

    def __init__(self):
        self.segments = []  # oldest first
        self.buffer = {}  # term -> [[doc, tf]], in arrival order
        self.buffered = []  # doc ids in the buffer

    def holds(self, doc):
        return doc in self.buffered or any(
            doc in seg.docs for seg in self.segments)

    # region index
    def index(self, doc, text):
        """Analyse text and add its terms to the buffer."""
        if self.holds(doc):  #@known_test
            return False  #@known
        self.buffered.append(doc)  #@start
        for word in text.split():  #@token
            term = word.lower()  #@lower
            if term in STOP_WORDS:
                continue  #@stop
            postings = self.buffer.setdefault(term, [])  #@add
            if postings and postings[-1][0] == doc:
                postings[-1][1] += 1  #@tf
            else:
                postings.append([doc, 1])  #@posting
        return True  #@done
    # endregion

    # region flush
    def flush(self):
        """Sort the buffer and write it out as a new segment."""
        if not self.buffered:
            return None  #@empty
        terms = sorted(self.buffer)  #@sort
        postings = {t: [tuple(p) for p in sorted(self.buffer[t])]
                    for t in terms}  #@sort
        seg = Segment(terms, postings, sorted(self.buffered))  #@write
        self.segments.append(seg)  #@publish
        self.buffer, self.buffered = {}, []  #@publish
        return seg
    # endregion

    # region search
    def search(self, term):
        """Live documents that hold term."""
        if term in STOP_WORDS:  #@search_start
            return []  #@stop_query
        hits = []
        for seg in self.segments:  #@segment
            for doc, tf in seg.lookup(term):  #@postings
                if seg.is_live(doc):  #@live
                    hits.append(doc)  #@hit
        return hits  #@hits
    # endregion

    # region and
    def search_and(self, a, b):
        """Live documents that hold both terms."""
        hits = []
        for seg in self.segments:  #@and_segment
            xs, ys = seg.lookup(a), seg.lookup(b)  #@and_lookup
            i = j = 0
            while i < len(xs) and j < len(ys):  #@walk
                x, y = xs[i][0], ys[j][0]
                if x == y:  #@cmp
                    if seg.is_live(x):  #@and_live
                        hits.append(x)  #@match
                    i, j = i + 1, j + 1  #@advance
                elif x < y:  #@cmp_less
                    i += 1  #@skip_a
                else:
                    j += 1  #@skip_b
        return hits  #@and_done
    # endregion

    # region or
    def search_or(self, a, b):
        """Live documents that hold either term."""
        hits = []
        for seg in self.segments:  #@or_segment
            xs, ys = seg.lookup(a), seg.lookup(b)  #@or_lookup
            i = j = 0
            out = []
            while i < len(xs) and j < len(ys):  #@or_walk
                x, y = xs[i][0], ys[j][0]
                if x == y:  #@or_cmp
                    out.append(x)  #@or_both
                    i, j = i + 1, j + 1  #@or_both
                elif x < y:  #@or_less
                    out.append(x)  #@take_x
                    i += 1  #@take_x
                else:
                    out.append(y)  #@take_y
                    j += 1  #@take_y
            out += [d for d, tf in xs[i:] + ys[j:]]  #@rest
            hits += [d for d in out if seg.is_live(d)]  #@or_live
        return hits  #@or_done
    # endregion

    # region delete
    def delete(self, doc):
        """Mark doc deleted with a tombstone. Nothing is rewritten."""
        for seg in self.segments:  #@find
            if doc in seg.docs and seg.is_live(doc):  #@find_test
                seg.deleted.add(doc)  #@tombstone
                return True  #@tombstone
        return False  #@not_found
    # endregion

    # region merge
    def merge(self, k):
        """Merge segments k and k + 1, leaving deleted docs behind."""
        a, b = self.segments[k], self.segments[k + 1]  #@merge_start
        terms, postings = [], {}
        i = j = 0
        while i < len(a.terms) or j < len(b.terms):  #@merge_walk
            ta = a.terms[i] if i < len(a.terms) else None
            tb = b.terms[j] if j < len(b.terms) else None
            if tb is None or (ta is not None and ta < tb):  #@merge_cmp
                term, docs = ta, a.live(ta)  #@take_a
                i += 1
            elif ta is None or tb < ta:  #@merge_cmp_more
                term, docs = tb, b.live(tb)  #@take_b
                j += 1
            else:
                # Lucene renumbers the documents, so it only appends.
                term, docs = ta, sorted(a.live(ta) + b.live(tb))  #@same
                i, j = i + 1, j + 1
            if docs:  #@keep
                terms.append(term)  #@keep
                postings[term] = docs  #@keep
        live = [d for s in (a, b) for d in s.docs if s.is_live(d)]
        merged = Segment(terms, postings, sorted(live))  #@replace
        self.segments[k:k + 2] = [merged] if live else []  #@replace
        return merged
    # endregion

    # region rank
    def rank(self, a, b):
        """Live documents holding a or b, best tf-idf score first."""
        n = sum(len(s.docs) - len(s.deleted) for s in self.segments)  #@count
        tfs = {}  # term -> {doc: tf}
        for term in dict.fromkeys([a, b]):
            found = tfs.setdefault(term, {})
            for seg in self.segments:  #@gather
                for doc, tf in seg.lookup(term):  #@gather
                    if seg.is_live(doc):  #@gather
                        found[doc] = tf  #@gather
        idf = {t: math.log10(n / len(f))
               for t, f in tfs.items() if f}  #@idf
        scores = {}
        for doc in sorted({d for f in tfs.values() for d in f}):  #@score
            scores[doc] = sum(
                tfs[t].get(doc, 0) * idf[t] for t in idf)  #@score
        return sorted(scores, key=lambda d: (-scores[d], d))  #@sort
    # endregion
