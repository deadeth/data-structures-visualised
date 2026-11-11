import type { Info } from '../../core/types';

export const info: Info = {
  summary:
    'SimHash turns a page into a short fingerprint that stays close when the text stays close. Every word is hashed, each bit position takes a vote (add 1 for a 1, take 1 away for a 0), and the sign of each total gives one bit. Pages that share most of their words cast mostly the same votes, so their fingerprints differ in only a few bits. This page uses 8 bits so the working fits on screen. Real systems use 64 bits and treat pages 3 bits or fewer apart as near-duplicates.',
  watch: [
    'Pages are picked by number from a fixed library of 12. Pages 1 to 3 are one news story: the original, a copy with "today" changed to "tonight", and a copy with an advert word added. Pages 4 to 6 and 7 to 9 do the same for a recipe and a football report. Pages 10 to 12 are unrelated to all of them.',
    'The word hash is fixed and printed in the code listing, so a word gives the same 8 bits on every page. That is why shared words pull two fingerprints together.',
    'In the tour, pages 1 and 2 differ by one word and their fingerprints differ by 1 bit. Pages 1 and 7 share no words and differ by 6 bits.',
    'A total of +1 or −1 is a close vote. Change one word and that bit can flip. A total of +5 would need three words to change. Real pages have hundreds of words, so a changed timestamp rarely moves any bit.',
    'A tie counts as 0 here. Page 12 has four words, so ties are possible: three of its eight columns end level.',
    'Compare needs only the two fingerprints. XOR marks the bits that differ and the count of 1s is the distance.',
    'Store page 1, then try Find near copies on page 10, a phone advert. It lands 1 bit from the storm story, a false positive. Eight bits leave room for only 256 fingerprints, so about 14% of unrelated pairs fall within 2 bits. With 64 bits and a threshold of 3 the chance is about 1 in 400 trillion.',
    'Set the threshold to 1, fingerprint pages 2 and 3 and compare them. They are copies of the same story 2 bits apart, so the match is missed. The threshold trades misses against false positives.',
  ],
  complexity: [
    { op: 'Fingerprint a page', average: 'O(w · b)', worst: 'O(w · b)', note: 'w words and b bits: one hash per word and one vote per bit. For a 64-bit fingerprint that is 64 additions per word.' },
    { op: 'Compare two fingerprints', average: 'O(1)', worst: 'O(1)', note: 'One XOR and one count of the 1s (popcount), both single CPU instructions on a 64-bit value. The listing counts bit by bit so each test can be shown.' },
    { op: 'Find near copies by scanning', average: 'O(n)', worst: 'O(n)', note: 'What this page animates: one comparison per stored page. Fine for thousands of pages, not for billions.' },
    { op: 'Find near copies with block tables', average: 'A few lookups', worst: 'O(n)', note: 'Split 64 bits into 4 blocks of 16. Two fingerprints within 3 bits must agree exactly on at least one block, so look up each block in its own sorted table and check only those candidates.' },
  ],
  space:
    'One fingerprint per page: 64 bits in a real system, whatever the size of the page. 8 billion pages need 64 GB for one copy. The block-table index keeps one permuted copy per table, so 4 tables hold about 256 GB before compression.',
  usedIn: [
    {
      name: 'Google web crawler',
      how: 'Manku, Jain and Das Sarma (2007) describe 64-bit SimHash fingerprints over 8 billion pages. A page within 3 bits of one already crawled is a near-duplicate. At that setting precision and recall were both about 0.75.',
    },
    {
      name: 'The web crawler design on this site',
      how: 'The parser computes an exact content hash and a SimHash for each page. The first catches identical copies. The second catches pages that differ only by adverts, timestamps or session tokens, and feeds the alarm for crawler traps.',
    },
    {
      name: 'Random hyperplane LSH',
      how: 'Charikar (2002) gave the scheme: each bit records which side of a random hyperplane a vector falls on. Two vectors at angle θ agree on a bit with probability 1 − θ/π, so the share of matching bits estimates cosine similarity. The same idea is used to shortlist similar embedding vectors.',
    },
    {
      name: 'Henzinger\'s evaluation (2006)',
      how: 'Monika Henzinger compared Charikar\'s fingerprint with Broder\'s shingling on 1.6 billion pages. SimHash reached a precision of 0.50 against 0.38, and combining the two reached 0.79.',
    },
  ],
  reachFor: [
    'Spotting pages that are the same apart from adverts, dates, counters or session tokens, where an exact hash is useless.',
    'You can afford only a few bytes per document and must compare a new one against billions.',
    'Near-duplicate means "almost all of the content matches". SimHash is at its best when the two documents are very close.',
    'Detecting crawler traps: a host that keeps returning near-identical pages under new URLs.',
  ],
  costs: [
    'False positives. Two different pages can land within the threshold by chance. Confirm with a fuller comparison before you discard anything that matters.',
    'Misses. A short page, or one where the changed part carries a lot of weight, can move more bits than the threshold allows.',
    'It answers "near or not" for small distances only. Two pages 20 bits apart and two pages 30 bits apart are both just "different". To measure how similar two documents are, MinHash estimates the overlap of their shingle sets directly.',
    'Everything depends on the features. Without stripping markup and boilerplate, the navigation shared by every page of a site makes them all look alike.',
    'Search within k bits needs the block-table index, and the number of tables grows quickly with k. The scheme suits k of about 3, not 10.',
    'To find exact copies, use an ordinary content hash such as SHA-256. It is simpler and has no false positives in practice.',
  ],
  interview: [
    'Place it next to the exact hash, not in place of it. "A content hash catches byte-identical copies. One changed timestamp changes every bit of that hash, so I also compute a SimHash, which moves only a few bits."',
    'Explain it in one breath: hash each feature to 64 bits, add the feature\'s weight to a counter where the bit is 1 and subtract it where the bit is 0, then keep the sign of each counter.',
    'Say what the weights are. A word that appears five times votes five times (term frequency), and rare words can be given more weight than common ones. Features are usually words or short runs of words (shingles) after stripping markup.',
    'Give the numbers from Manku, Jain and Das Sarma: 64 bits, 3 bits or fewer apart, 8 billion pages.',
    'Explain the search. A linear scan is out. Split the 64 bits into 4 blocks of 16. Three differing bits can touch at most three blocks, so one block matches exactly. Keep 4 copies of the fingerprints, each permuted so a different block leads, sorted. A query does 4 prefix lookups and checks the candidates with XOR and popcount.',
    'Know the trade-off in that index. With 2^34 fingerprints, matching 16 bits leaves about 2^18 = 262,144 candidates per table. Splitting further gives 16 tables that match 28 bits and leave about 64 candidates each. More tables, less checking.',
    'SimHash or MinHash? SimHash gives one small fingerprint per page and estimates cosine similarity, which suits "is this nearly the same page" at crawl scale. MinHash keeps many values per page and estimates Jaccard overlap, which suits "how similar are these two" and clustering.',
    'Say what the crawler does with a near-duplicate: store a pointer to the first copy, do not index it again, and do not extract its links again. Treat a host that produces many of them as a likely trap and cut its budget. Because false positives happen, some systems use the result as one signal for crawl priority and not as a final verdict.',
  ],
};
