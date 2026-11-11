import type { Info } from '../../core/types';

export const info: Info = {
  summary:
    'A column store keeps each column of a table on its own instead of keeping each row together. A query that needs 2 columns of a 50-column table reads 2 columns, not 50. Values of one column look alike, so they compress well, and a small summary of each block (its min and max) lets a reader skip blocks that cannot match. Parquet is the common file format built this way: rows are cut into row groups, and each column of a row group is stored as a column chunk.',
  watch: [
    'Sum with layout row reads every row, all 4 values of it, to use 3 amounts: 48 values and 192 bytes. With layout column the same query reads only the country and amount chunks of 1 row group. Compare the Values read and Bytes read counters.',
    'The caption under each column chunk is its min and max. A query for UK skips row group 0 because UK > max DE, and row group 1 because UK > max FR, without reading a single value from either.',
    'Ask for PL. It falls between IT and UK, so min and max cannot rule out row group 2. If country is encoded, the chunk\'s dictionary has no PL and the reader stops there; if not, it scans 4 values and finds nothing.',
    'Encode country. Each chunk gets its own dictionary, every value becomes a small code, and then runs of the same code are stored once with a count. The table is sorted by country, so each chunk is 1 or 2 runs. Encode day or product to see short runs, and amount to see encoding make a chunk bigger.',
    'After encoding, the filter looks UK up once in the dictionary and then compares codes. One comparison against a run covers every row in it.',
    'Bitmap AND keeps one bitmap per distinct value. FR AND tea is one bitwise AND of two rows of bits, then a count of the 1s.',
    'Append puts the row in a memory buffer. Only when the buffer holds 2 rows is it sorted, cut into column chunks with their own min and max, and written as a new file. The old files are never touched.',
    'Simplified here: every value and dictionary entry takes 4 bytes, a code 1 byte and a run 2 bytes. Real Parquet bit-packs codes, mixes runs with bit-packed groups, compresses each page (Snappy or Zstandard, for example) and aims for row groups of about 128 MB, not 4 rows. Reading the footer is not counted.',
  ],
  complexity: [
    { op: 'Scan 1 column of n rows', average: 'O(n)', worst: 'O(n)', note: 'Reads only that column\'s bytes, after encoding and compression. A row store reads every column to do the same.' },
    { op: 'Filter with min and max', average: 'O(groups) + matching groups', worst: 'O(n)', note: 'One check per row group skips the rest. Data sorted by the filtered column makes most groups skippable; unsorted data can make every group overlap.' },
    { op: 'Fetch one whole row', average: 'O(columns)', worst: 'O(columns)', note: 'One read per column, each in a different place. A row store needs one.' },
    { op: 'Insert one row', average: 'O(columns), batched', worst: 'Rewrite a file', note: 'Files are immutable. Rows are buffered and written out as new files in batches.' },
    { op: 'Update or delete one row', average: 'Rewrite a file', worst: 'Rewrite a file', note: 'Or write a delete marker that readers apply, and rewrite later. Lakehouse table formats do both.' },
    { op: 'AND two bitmaps', average: 'O(n / 64)', worst: 'O(n / 64)', note: 'One machine instruction per 64 rows, before compression of the bitmaps themselves.' },
  ],
  space:
    'The raw data, usually much smaller after encoding and compression, plus per-chunk metadata: offsets, value counts and min and max. On this page the country column goes from 48 bytes plain to 28 as dictionaries and codes, and 24 as dictionaries and runs. At 12 rows the dictionaries are most of that; at millions of rows per row group they are a rounding error, and a sorted column is still a few runs.',
  usedIn: [
    {
      name: 'Apache Parquet',
      how: 'A file holds row groups, a row group holds one column chunk per column, and a chunk holds pages. A dictionary page, when used, comes first in its chunk. The footer at the end of the file holds the schema and, for every chunk, its position and min and max, so a reader fetches the footer and then only the chunks it needs.',
    },
    {
      name: 'Apache Spark and Trino',
      how: 'Both read Parquet and ORC and push filters down to the reader, so row groups whose statistics rule a filter out are never read, and only the selected columns are fetched. Parquet is Spark SQL\'s default file format.',
    },
    {
      name: 'Apache ORC',
      how: 'A sibling of Parquet from the Hive world. Stripes play the part of row groups, and each keeps min and max per column for the whole stripe and for every 10,000 rows within it.',
    },
    {
      name: 'Google BigQuery',
      how: 'Stores tables in its own columnar format, Capacitor, and bills on-demand queries by the bytes of the columns they read. Selecting fewer columns makes a query cheaper.',
    },
    {
      name: 'Amazon Redshift',
      how: 'Stores each column in 1 MB blocks and keeps the min and max of every block as a zone map, so a range filter skips blocks. A sort key decides which column the blocks are ordered by.',
    },
    {
      name: 'Snowflake',
      how: 'Stores tables as micro-partitions of 50 to 500 MB of uncompressed data, each organised by column, with min and max per column that the optimiser uses to prune micro-partitions.',
    },
    {
      name: 'ClickHouse',
      how: 'A MergeTree table writes each insert as a new part, with one file per column, sorted by the table\'s ORDER BY key. Background merges combine parts, much as an LSM tree compacts. A sparse index holds one entry per 8,192 rows.',
    },
  ],
  reachFor: [
    'Analytics: aggregates and filters over many rows that touch a few columns of a wide table. Dashboards, reports, ad hoc SQL over events, logs or sales.',
    'Data lakes: a table as Parquet files in object storage, read by Spark, Trino or a warehouse, where every byte not fetched is time and money saved.',
    'Data that is written in bulk and then only read, such as daily loads, event streams batched into files, or history that never changes.',
    'Columns with few distinct values or long sorted stretches: country, status, date. They encode to almost nothing.',
  ],
  costs: [
    'Point lookups are slow. Fetching one whole row means one read per column, each from a different place. A key-value store or a row store with a B+ tree index does it in one.',
    'Frequent single-row inserts, updates and deletes do not fit. Files are immutable, so a change means writing a new file, or a delete marker that every reader must apply until the file is rewritten. Batch writes, or keep recent rows in a row store and move them over later.',
    'Many small files hurt. Each has its own footer to read and its own min and max, and appended files rarely keep the sort order, so their ranges overlap. Plan for compaction.',
    'Skipping only works when the data is sorted or clustered by the column you filter on. You choose one sort order; filters on other columns get little help from min and max.',
    'SELECT * gives the benefit away: it reads every column and then has to stitch the rows back together.',
  ],
  interview: [
    'OLTP or OLAP first. OLTP is many small transactions on single rows, such as placing an order: keep rows together and index them (Postgres, MySQL). OLAP is few large queries over millions of rows and a handful of columns, such as revenue by country per month: store columns.',
    'Say why columns compress: one column holds one type and similar values. Dictionary encoding turns repeated strings into small codes, and run-length encoding stores a run of equal codes once. Sorting makes the runs long.',
    'Pick the sort column out loud. Sort by the column most queries filter on, often date or tenant, then perhaps a second one. That makes min and max per row group tight, so whole row groups are skipped, and makes the runs in the sort column long.',
    'Predicate pushdown and projection: the engine hands the filter and the list of columns to the file reader. The reader checks each row group\'s min and max in the footer and fetches only the chunks it needs. Name it when asked how a lake query stays cheap.',
    'Late materialisation and vectorised execution in two sentences: filter on the narrow columns first and fetch the other columns only for the rows that pass. Process a batch of a column at a time, a thousand values or so in a tight loop, instead of one row at a time through the whole query plan.',
    'Writes: "I would not write single rows to Parquet. I would buffer them, as an LSM tree does, and write files of hundreds of megabytes, then compact the small ones." Table formats such as Delta Lake and Apache Iceberg add transactions, deletes and file-level statistics on top of Parquet files.',
    'Do not confuse a column store with a wide-column store. Cassandra and HBase are wide-column stores: rows found by key, each row with many columns, stored row by row (HBase per column family). They are built for key lookups and writes, not for scanning one column across billions of rows.',
    'Bitmap indexes fit columns with few distinct values: one bitmap per value, and AND, OR and NOT of conditions become bitwise operations. Engines such as Apache Druid and Apache Pinot keep compressed bitmaps per value.',
  ],
};
