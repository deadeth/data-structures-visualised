COLUMNS = ("day", "country", "product", "amount")
GROUP_ROWS = 4  # rows per row group; Parquet's default is 128 MB
FLUSH_ROWS = 2  # rows the buffer holds before it becomes a file

SAMPLE = [
    (1, "DE", "tea", 12), (1, "DE", "pie", 30), (2, "DE", "tea", 18),
    (3, "DE", "jam", 25), (1, "FR", "tea", 40), (2, "FR", "pie", 15),
    (2, "FR", "tea", 22), (3, "FR", "tea", 35), (2, "IT", "jam", 10),
    (1, "UK", "tea", 28), (2, "UK", "jam", 16), (3, "UK", "tea", 45),
]


class Chunk:
    """One column of one row group."""

    # region chunk
    def __init__(self, values):
        """Store the values and remember their min and max."""
        self.values = values
        self.lo = min(values)  #@stats
        self.hi = max(values)  #@stats
        self.dictionary = None  # set by encode()
        self.runs = None
    # endregion

    def read(self):
        """The plain values, decoded if the chunk is encoded."""
        if self.runs is None:
            return list(self.values)
        out = []
        for code, count in self.runs:
            out.extend([self.dictionary[code]] * count)
        return out

    # region encode_chunk
    def encode(self):
        """Dictionary-encode, then run-length encode the codes."""
        dictionary, codes = [], []
        for value in self.values:  #@next_value
            if value not in dictionary:  #@lookup
                dictionary.append(value)  #@add
            codes.append(dictionary.index(value))  #@code
        runs = []
        for code in codes:  #@next_code
            if runs and runs[-1][0] == code:  #@same
                runs[-1][1] += 1  #@extend
            else:
                runs.append([code, 1])  #@new_run
        self.dictionary, self.runs = dictionary, runs  #@store
        self.values = None  #@store
    # endregion

    # region matching
    def matching(self, value):
        """Positions in this chunk that hold value."""
        hits = []
        if self.runs is None:
            for i, v in enumerate(self.values):
                if v == value:  #@scan
                    hits.append(i)  #@hit
            return hits
        if value not in self.dictionary:  #@dict_test
            return hits  #@dict_miss
        code = self.dictionary.index(value)  #@dict_hit
        start = 0
        for c, count in self.runs:
            if c == code:  #@run_test
                hits.extend(range(start, start + count))  #@run_hit
            start += count
        return hits
    # endregion


class ColumnStore:
    """One table kept two ways: a row file and a column file."""

    def __init__(self, rows=SAMPLE):
        self.load(rows)

    def load(self, rows):
        """Sort by country and cut the rows into row groups."""
        rows = sorted(rows, key=lambda r: r[1])
        self.rows = list(rows)  # the row file
        self.groups = []  # the column files, as row groups
        for i in range(0, len(rows), GROUP_ROWS):
            part = rows[i:i + GROUP_ROWS]
            group = {}
            for j, name in enumerate(COLUMNS):
                group[name] = Chunk([r[j] for r in part])
            self.groups.append(group)
        self.buffer = []  # rows not yet in a column file
        self.encoded = set()

    # region sum_rows
    def sum_rows(self, country):
        """SUM(amount) WHERE country = x, reading whole rows."""
        total = 0
        for row in self.rows:  #@row_read
            day, c, product, amount = row  #@row_read
            if c == country:  #@row_test
                total += amount  #@row_add
        return total  #@row_done
    # endregion

    # region sum_columns
    def sum_columns(self, country):
        """The same query, reading two columns and skipping groups."""
        total = 0
        for group in self.groups:  #@group
            stats = group["country"]
            if country > stats.hi:  #@above
                continue  #@skip
            if country < stats.lo:  #@below
                continue  #@skip
            hits = group["country"].matching(country)  #@filter
            if not hits:
                continue  #@none
            amounts = group["amount"].read()  #@amounts
            for i in hits:
                total += amounts[i]  #@add
        for row in self.buffer:  # rows still in memory
            if row[1] == country:  #@buffer_test
                total += row[3]  #@buffer_add
        return total  #@col_done
    # endregion

    # region encode
    def encode(self, name):
        """Encode one column, one chunk at a time."""
        if name in self.encoded:
            return  #@already
        self.encoded.add(name)  #@mark
        for group in self.groups:  #@each_chunk
            group[name].encode()  #@each_chunk
    # endregion

    # region bitmap
    def count_both(self, country, product):
        """COUNT(*) WHERE country = x AND product = y."""
        by_country = self.bitmaps("country")  #@build
        by_product = self.bitmaps("product")  #@build
        a = by_country.get(country, 0)  #@pick_a
        b = by_product.get(product, 0)  #@pick_b
        both = a & b  #@and
        count = bin(both).count("1")  #@count
        for row in self.buffer:  # not indexed yet
            if row[1] == country and row[2] == product:  #@buffer_test
                count += 1  #@buffer_add
        return count  #@both_done
    # endregion

    # region bitmaps
    def bitmaps(self, name):
        """One bitmap per distinct value: bit i is set if row i has it."""
        maps = {}
        i = 0
        for group in self.groups:
            for value in group[name].read():  #@set_bit
                maps[value] = maps.get(value, 0) | (1 << i)  #@set_bit
                i += 1
        return maps
    # endregion

    # region append
    def append(self, row):
        """Add a row. A column file is only ever written whole."""
        self.rows.append(row)  #@row_file
        self.buffer.append(row)  #@buffer
        if len(self.buffer) >= FLUSH_ROWS:  #@full
            self.flush()  #@flush
    # endregion

    # region flush
    def flush(self):
        """Write the buffer out as a new file of one row group."""
        rows = sorted(self.buffer, key=lambda r: r[1])  #@sort
        group = {}
        for j, name in enumerate(COLUMNS):  #@split
            group[name] = Chunk([r[j] for r in rows])  #@split
            if name in self.encoded:
                group[name].encode()  #@split
        self.groups.append(group)  #@write
        self.buffer = []  #@write
    # endregion

    # region reset
    def reset(self):
        """Back to the example table."""
        self.load(SAMPLE)  #@reset
    # endregion
