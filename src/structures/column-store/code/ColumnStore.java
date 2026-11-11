import java.util.ArrayList;
import java.util.BitSet;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.Function;

/** One table kept two ways: a row file and a column file. */
public class ColumnStore {
    static final int GROUP_ROWS = 4; // Parquet's default is 128 MB
    static final int FLUSH_ROWS = 2; // buffered rows before a flush
    static final List<String> COLUMNS =
        List.of("day", "country", "product", "amount");

    record Row(int day, String country, String product, int amount) {}

    static final List<Row> SAMPLE = List.of(
        new Row(1, "DE", "tea", 12), new Row(1, "DE", "pie", 30),
        new Row(2, "DE", "tea", 18), new Row(3, "DE", "jam", 25),
        new Row(1, "FR", "tea", 40), new Row(2, "FR", "pie", 15),
        new Row(2, "FR", "tea", 22), new Row(3, "FR", "tea", 35),
        new Row(2, "IT", "jam", 10), new Row(1, "UK", "tea", 28),
        new Row(2, "UK", "jam", 16), new Row(3, "UK", "tea", 45));

    /** One column of one row group. */
    static final class Chunk<T extends Comparable<T>> {
        List<T> values;
        final T lo;
        final T hi;
        List<T> dictionary; // set by encode()
        List<int[]> runs; // {code, count}

        // region chunk
        /** Stores the values and remembers their min and max. */
        Chunk(List<T> values) {
            this.values = values;
            lo = Collections.min(values); //@stats
            hi = Collections.max(values); //@stats
        }
        // endregion

        /** The plain values, decoded if the chunk is encoded. */
        List<T> read() {
            if (runs == null) return new ArrayList<>(values);
            List<T> out = new ArrayList<>();
            for (int[] run : runs) {
                out.addAll(Collections.nCopies(run[1], dictionary.get(run[0])));
            }
            return out;
        }

        // region encode_chunk
        /** Dictionary-encodes, then run-length encodes the codes. */
        void encode() {
            List<T> dict = new ArrayList<>();
            List<Integer> codes = new ArrayList<>();
            for (T value : values) { //@next_value
                if (!dict.contains(value)) { //@lookup
                    dict.add(value); //@add
                }
                codes.add(dict.indexOf(value)); //@code
            }
            List<int[]> out = new ArrayList<>();
            for (int code : codes) { //@next_code
                int[] last = out.isEmpty() ? null : out.get(out.size() - 1);
                if (last != null && last[0] == code) { //@same
                    last[1]++; //@extend
                } else {
                    out.add(new int[] {code, 1}); //@new_run
                }
            }
            dictionary = dict; //@store
            runs = out; //@store
            values = null; //@store
        }
        // endregion

        // region matching
        /** Positions in this chunk that hold value. */
        List<Integer> matching(T value) {
            List<Integer> hits = new ArrayList<>();
            if (runs == null) {
                for (int i = 0; i < values.size(); i++) {
                    if (values.get(i).equals(value)) { //@scan
                        hits.add(i); //@hit
                    }
                }
                return hits;
            }
            if (!dictionary.contains(value)) { //@dict_test
                return hits; //@dict_miss
            }
            int code = dictionary.indexOf(value); //@dict_hit
            int start = 0;
            for (int[] run : runs) {
                if (run[0] == code) { //@run_test
                    for (int i = 0; i < run[1]; i++) hits.add(start + i); //@run_hit
                }
                start += run[1];
            }
            return hits;
        }
        // endregion
    }

    /** A row group: one chunk per column. */
    record Group(Chunk<Integer> day, Chunk<String> country,
                 Chunk<String> product, Chunk<Integer> amount) {
        Chunk<?> get(String name) {
            return switch (name) {
                case "day" -> day;
                case "country" -> country;
                case "product" -> product;
                default -> amount;
            };
        }
    }

    List<Row> rows; // the row file
    List<Group> groups; // the column files, as row groups
    List<Row> buffer; // rows not yet in a column file
    Set<String> encoded;

    public ColumnStore() {
        load(SAMPLE);
    }

    public ColumnStore(List<Row> sample) {
        load(sample);
    }

    /** Sorts by country and cuts the rows into row groups. */
    void load(List<Row> sample) {
        List<Row> sorted = new ArrayList<>(sample);
        sorted.sort(Comparator.comparing(Row::country));
        rows = new ArrayList<>(sorted);
        groups = new ArrayList<>();
        for (int i = 0; i < sorted.size(); i += GROUP_ROWS) {
            int end = Math.min(sorted.size(), i + GROUP_ROWS);
            groups.add(makeGroup(sorted.subList(i, end)));
        }
        buffer = new ArrayList<>();
        encoded = new HashSet<>();
    }

    static <T extends Comparable<T>> Chunk<T> chunk(
            List<Row> part, Function<Row, T> column) {
        List<T> values = new ArrayList<>();
        for (Row r : part) values.add(column.apply(r));
        return new Chunk<>(values);
    }

    static Group makeGroup(List<Row> part) {
        return new Group(chunk(part, Row::day), chunk(part, Row::country),
            chunk(part, Row::product), chunk(part, Row::amount));
    }

    // region sum_rows
    /** SUM(amount) WHERE country = x, reading whole rows. */
    public int sumRows(String country) {
        int total = 0;
        for (Row row : rows) { //@row_read
            if (row.country().equals(country)) { //@row_test
                total += row.amount(); //@row_add
            }
        }
        return total; //@row_done
    }
    // endregion

    // region sum_columns
    /** The same query, reading two columns and skipping groups. */
    public int sumColumns(String country) {
        int total = 0;
        for (Group group : groups) { //@group
            Chunk<String> stats = group.country();
            if (country.compareTo(stats.hi) > 0) { //@above
                continue; //@skip
            }
            if (country.compareTo(stats.lo) < 0) { //@below
                continue; //@skip
            }
            List<Integer> hits = group.country().matching(country); //@filter
            if (hits.isEmpty()) {
                continue; //@none
            }
            List<Integer> amounts = group.amount().read(); //@amounts
            for (int i : hits) {
                total += amounts.get(i); //@add
            }
        }
        for (Row row : buffer) { // rows still in memory
            if (row.country().equals(country)) { //@buffer_test
                total += row.amount(); //@buffer_add
            }
        }
        return total; //@col_done
    }
    // endregion

    // region encode
    /** Encodes one column, one chunk at a time. */
    public void encode(String name) {
        if (encoded.contains(name)) {
            return; //@already
        }
        encoded.add(name); //@mark
        for (Group group : groups) { //@each_chunk
            group.get(name).encode(); //@each_chunk
        }
    }
    // endregion

    // region bitmap
    /** COUNT(*) WHERE country = x AND product = y. */
    public int countBoth(String country, String product) {
        Map<Object, BitSet> byCountry = bitmaps("country"); //@build
        Map<Object, BitSet> byProduct = bitmaps("product"); //@build
        BitSet a = byCountry.getOrDefault(country, new BitSet()); //@pick_a
        BitSet b = byProduct.getOrDefault(product, new BitSet()); //@pick_b
        BitSet both = (BitSet) a.clone(); //@and
        both.and(b); //@and
        int count = both.cardinality(); //@count
        for (Row row : buffer) { // not indexed yet
            if (row.country().equals(country)
                    && row.product().equals(product)) { //@buffer_test
                count++; //@buffer_add
            }
        }
        return count; //@both_done
    }
    // endregion

    // region bitmaps
    /** One bitmap per distinct value: bit i is set if row i has it. */
    Map<Object, BitSet> bitmaps(String name) {
        Map<Object, BitSet> maps = new HashMap<>();
        int i = 0;
        for (Group group : groups) {
            for (Object value : group.get(name).read()) { //@set_bit
                maps.computeIfAbsent(value, v -> new BitSet()).set(i); //@set_bit
                i++;
            }
        }
        return maps;
    }
    // endregion

    // region append
    /** Adds a row. A column file is only ever written whole. */
    public void append(Row row) {
        rows.add(row); //@row_file
        buffer.add(row); //@buffer
        if (buffer.size() >= FLUSH_ROWS) { //@full
            flush(); //@flush
        }
    }
    // endregion

    // region flush
    /** Writes the buffer out as a new file of one row group. */
    void flush() {
        buffer.sort(Comparator.comparing(Row::country)); //@sort
        Group group = makeGroup(buffer); //@split
        for (String name : encoded) {
            group.get(name).encode(); //@split
        }
        groups.add(group); //@write
        buffer = new ArrayList<>(); //@write
    }
    // endregion

    // region reset
    /** Back to the example table. */
    public void reset() {
        load(SAMPLE); //@reset
    }
    // endregion
}
