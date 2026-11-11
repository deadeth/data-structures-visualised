import type { Info } from '../../core/types';

export const info: Info = {
  summary:
    'An inverted index maps each term to the sorted list of documents that hold it, its postings list. A search looks the term up in a sorted term dictionary and reads its list; a query with two terms walks two lists together. Lucene keeps the index as a few immutable segments plus an in-memory buffer, so writes never touch what readers are reading.',
  watch: [
    'Index splits the text into tokens, lower-cases them and drops stop words. "Fox" and "fox" become one term, and "the" never reaches the index. Each remaining term gets the document id in the buffer, with a count of how often it appeared.',
    'The buffer is not searchable. After Index, a search cannot see the new document until Flush sorts the buffer and writes it out as a segment. That gap is what "near real time" means.',
    'Search runs one binary search per segment, each on that segment\'s own sorted terms. Three segments cost three searches, which is why merging matters.',
    'AND walks two sorted postings lists with one pointer each. The smaller doc id cannot be on both lists, so its pointer moves on. A segment that lacks one of the terms is skipped without reading anything.',
    'Delete changes one bit. The postings still list the document, and every search filters it out against the live-docs set. Watch the red cell in the segment header.',
    'Merge walks two sorted term dictionaries as merge sort does and copies each postings list without the deleted documents. Only now is the deleted document gone and its space reclaimed.',
    'Rank shows tf and idf. In the tour, document 5 says "fox" twice, but document 1 holds "red", which is rarer, and wins.',
    'Simplified here: a document\'s id is its number in the library (Lucene numbers documents in arrival order, per segment, and renumbers on merge); at most 3 segments and 5 documents are drawn; the analyser only splits on spaces, lower-cases and drops "a", "and" and "the"; the score is plain tf-idf, not BM25.',
  ],
  complexity: [
    { op: 'Search one term', average: 'O(s log t + p)', worst: 'O(s log t + p)', note: 's segments, t terms in each, p postings read. Lucene\'s term index is an FST, so the lookup is close to the length of the term.' },
    { op: 'AND of two terms', average: 'O(a + b)', worst: 'O(a + b)', note: 'One pass over both lists. With skip data it is nearer O(a log b) when a is much shorter than b.' },
    { op: 'OR of two terms', average: 'O(a + b)', worst: 'O(a + b)', note: 'Every entry of both lists is visited.' },
    { op: 'Index a document', average: 'O(w)', worst: 'O(w)', note: 'w words, each a hash table update in the buffer. Not searchable yet.' },
    { op: 'Flush', average: 'O(t log t + p)', worst: 'O(t log t + p)', note: 'Sort the buffer\'s terms, write terms and postings once.' },
    { op: 'Delete', average: 'O(s log t)', worst: 'O(s log t)', note: 'Find the document by its id term, then set one bit. Nothing is rewritten.' },
    { op: 'Merge two segments', average: 'O(t + p)', worst: 'O(t + p)', note: 'Reads and rewrites every term and posting of both segments.' },
    { op: 'Rank, top k', average: 'O(m log k)', worst: 'O(m log k)', note: 'm matching documents, each scored and offered to a heap of size k.' },
  ],
  space:
    'About one posting per distinct term per document, plus the term dictionary. Postings compress well: Lucene stores the gaps between doc ids, not the ids, packs them in blocks of 128 with just enough bits for the largest gap, and writes the leftover gaps as variable-length integers. A common term with gaps under 16 needs 4 bits a document instead of 32.',
  usedIn: [
    {
      name: 'Apache Lucene',
      how: 'The library under most search engines. Each segment holds a term dictionary, with an FST as its in-memory term index, and compressed postings. Deletes go into a live-docs bitset per segment and are reclaimed by merges, chosen by default by the tiered merge policy.',
    },
    {
      name: 'Elasticsearch and OpenSearch',
      how: 'An index is split into primary shards, each a Lucene index, with replica copies on other nodes. A document goes to a shard by a hash of its routing value, its id by default. A refresh, once a second by default, makes new segments searchable.',
    },
    {
      name: 'Apache Solr',
      how: 'Built on Lucene too, with the same segments, refresh and merging under its own names: a soft commit makes documents visible, a hard commit makes them durable.',
    },
    {
      name: 'PostgreSQL',
      how: 'Full-text search stores a tsvector of normalised words per row. A GIN index (generalised inverted index) on it maps each word to the rows that hold it, so a text query does not scan the table.',
    },
    {
      name: 'Tantivy',
      how: 'A full-text search library in Rust, modelled on Lucene: immutable segments, a term dictionary held as an FST, compressed postings, merges.',
    },
  ],
  reachFor: [
    'Finding documents by the words in them: product search, help articles, log lines, emails. Any "contains this word" question over a lot of text.',
    'Queries that combine many terms with AND, OR and NOT, ranked by relevance, with typo tolerance and prefixes.',
    'Filtering and counting over many fields at once (facets). Each field value is a term, so a filter is a postings list and filters combine by intersection.',
    'Data that is written once and read many times. Immutable segments make reads cheap and lock-free and compress well.',
  ],
  costs: [
    'Writes are not visible at once. A document is searchable after the next refresh, about a second in Elasticsearch. Read-your-own-writes needs a forced refresh, which makes small segments and costs throughput.',
    'An update is a delete plus a new document. Updating one field rewrites the whole document, and the old copy wastes space until a merge.',
    'Merging rewrites data again and again. Heavy indexing spends a large share of disk and CPU on merges, and a big merge can slow searches while it runs.',
    'It is not a primary store. Elasticsearch has no multi-document transactions and changing how a field is analysed means reindexing. Keep the source of truth in a database and feed the index from it, by change data capture or an outbox, so it can be rebuilt.',
    'Scores depend on statistics. Elasticsearch uses each shard\'s own term counts by default, and deleted documents still count until merged, so the same query can score slightly differently across shards and over time.',
    'Deep paging is expensive. Results 9,991 to 10,000 make every shard send its top 10,000 to the coordinating node. Elasticsearch caps from + size at 10,000 by default; page with search_after instead.',
    'For exact lookups by key or range scans on numbers and dates, a B-tree or the database you already have is simpler.',
  ],
  interview: [
    'Start with why a B-tree does not help. A B-tree on a text column answers "starts with" (LIKE \'red%\'), because that is a range of sorted keys. "Contains the word red" is not a range: every row must be scanned. An inverted index flips the problem round: from each word to the documents that hold it.',
    'Name the two parts: a term dictionary, sorted so lookups, prefixes and ranges work, and postings lists of doc ids, sorted so lists can be intersected in one pass. Postings can also carry the term frequency and positions, which phrase queries such as "red fox" need.',
    'Analysis decides what the terms are, and documents and queries must use the same analyser. A tokeniser splits the text; filters lower-case, remove stop words, stem ("runs" and "running" both become "run") and add synonyms. Elasticsearch\'s standard analyser lower-cases but keeps stop words by default.',
    'Prefix and fuzzy search go through the term dictionary, not the postings. A prefix is a range of sorted terms. Lucene stores the term index as an FST, a compressed trie that also shares suffixes (see the trie page on this site), and finds terms within 1 or 2 edits by walking it with a Levenshtein automaton.',
    'Intersection is the core query. Walk the shortest list and ask the others to skip ahead to each candidate. Long postings lists carry skip data so the jump does not read every entry (see the skip list page). Recent Lucene versions interleave two levels of skip data with the blocks of 128 doc ids.',
    'Compression: store the gaps between sorted doc ids, which are small, then pack them in fixed blocks or as variable-length integers, where small numbers take one byte. Smaller lists mean fewer disk reads and more of the index in the page cache.',
    'Writes work like an LSM tree. New documents go to an in-memory buffer, a flush writes an immutable segment, a delete is a tombstone, and background merges combine segments and drop the dead documents. The same trade-off too: cheap writes, reads that touch several segments, and write amplification from merging.',
    'Know Elasticsearch\'s words. A refresh writes the buffer as a segment and opens it for search, once a second by default, but does not fsync it. A flush is a Lucene commit: segments are fsynced and the transaction log can be trimmed. Until then, the translog makes acknowledged writes durable.',
    'Scaling: shard by document. Each shard is a whole Lucene index over part of the documents, and one Lucene index can hold at most about 2.1 billion. A search is scatter-gather: the query phase asks one copy of every shard for its top doc ids and scores, the coordinating node merges them, and the fetch phase reads only the documents that made the final page. Replicas add read capacity and survive a node failure.',
    'Ranking: tf-idf says a term counts more the more often it appears in a document and the fewer documents hold it. BM25 is the default in Lucene and Elasticsearch: term frequency saturates (k1 = 1.2 by default) and long documents are normalised (b = 0.75). Keep the top k in a heap of size k rather than sorting every match.',
    'Keep it in sync with the database: write to the database, capture the change (an outbox table or change data capture into Kafka) and index from that stream. The index can then be rebuilt from scratch whenever the mapping or the analyser changes.',
  ],
};
