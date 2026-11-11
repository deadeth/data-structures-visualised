import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** Protobuf-style and Avro-style encoding of one small record. */
public class Serialization {
    static final int VARINT = 0, I64 = 1, LEN = 2, I32 = 5; // wire types
    /** Marks an Avro reader field with no default. */
    static final Object MISSING = new Object();

    /** One field of a schema: number, name, type and default. */
    public record Field(int num, String name, String type, Object def) {}

    /** A position in a byte array, moved along as bytes are read. */
    static final class Cursor {
        final byte[] data;
        int pos;

        Cursor(byte[] data) {
            this.data = data;
        }

        int next() {
            return data[pos++] & 0xFF;
        }
    }

    static int wireType(Field f) {
        String t = f.type();
        return t.equals("string") || t.equals("int32[]") ? LEN : VARINT;
    }

    @SuppressWarnings("unchecked")
    static List<Integer> ints(Object value) {
        return (List<Integer>) value;
    }

    static String utf8(byte[] data, int from, int to) {
        return new String(data, from, to - from, StandardCharsets.UTF_8);
    }

    static byte[] bytesOf(Object s) {
        return ((String) s).getBytes(StandardCharsets.UTF_8);
    }

    // region encode
    /** Protobuf-style: a key before every value. */
    public static byte[] encode(Map<String, Object> record, List<Field> schema) {
        var out = new ByteArrayOutputStream();
        for (Field f : schema) {
            Object value = record.get(f.name()); //@e_field
            if (value == null || value.equals(List.of())) {
                continue; // unset or empty: no bytes at all //@e_absent
            }
            int wire = wireType(f);
            writeVarint(out, f.num() << 3 | wire); //@e_key
            if (f.type().equals("string")) {
                byte[] data = bytesOf(value);
                writeVarint(out, data.length); //@e_len
                out.writeBytes(data); //@e_bytes
            } else if (f.type().equals("int32[]")) {
                var packed = new ByteArrayOutputStream();
                for (int v : ints(value)) {
                    writeVarint(packed, v); //@e_pack
                }
                writeVarint(out, packed.size()); //@e_len
                out.writeBytes(packed.toByteArray()); //@e_bytes
            } else if (f.type().equals("sint32")) {
                writeVarint(out, zigzag((Integer) value)); //@e_zigzag
            } else {
                writeVarint(out, (Integer) value); //@e_value
            }
        }
        return out.toByteArray(); //@e_done
    }
    // endregion

    // region write_varint
    /** Seven bits per byte, lowest group first. */
    static void writeVarint(ByteArrayOutputStream out, long n) {
        // An int widened to long keeps its sign: a negative takes ten bytes.
        while ((n & ~0x7FL) != 0) { // n >= 128, unsigned //@w_more
            out.write((int) (n & 0x7F | 0x80)); // top bit: more follow //@w_more
            n >>>= 7; //@w_more
        }
        out.write((int) n); // top bit clear: the last byte //@w_last
    }
    // endregion

    // region zigzag
    /** 0, -1, 1, -2 become 0, 1, 2, 3. */
    static long zigzag(int n) {
        return ((long) n << 1) ^ (n >> 31); //@z_enc
    }

    /** The inverse: 0, 1, 2, 3 become 0, -1, 1, -2. */
    static long unzigzag(long n) {
        return (n >>> 1) ^ -(n & 1); //@z_dec
    }
    // endregion

    // region decode
    /** Reads keys; looks each field number up in the reader's schema. */
    public static Map<String, Object> decode(byte[] data, List<Field> schema) {
        Map<Integer, Field> byNum = new HashMap<>();
        for (Field f : schema) {
            byNum.put(f.num(), f);
        }
        Map<String, Object> record = new LinkedHashMap<>();
        var in = new Cursor(data);
        while (in.pos < data.length) { //@d_loop
            long key = readVarint(in); //@d_key
            int num = (int) (key >>> 3), wire = (int) (key & 7); //@d_split
            Field f = byNum.get(num); //@d_lookup
            if (f == null || wire != wireType(f)) { //@d_lookup
                skip(in, wire); // unknown: skip it //@d_unknown
                continue;
            }
            if (wire == VARINT) {
                long n = readVarint(in); //@d_varint
                if (f.type().equals("sint32")) {
                    n = unzigzag(n); //@d_zigzag
                }
                record.put(f.name(), (int) n); //@d_varint
                continue;
            }
            int size = (int) readVarint(in); //@d_len
            int end = in.pos + size; //@d_len
            if (f.type().equals("string")) {
                record.put(f.name(), utf8(data, in.pos, end)); //@d_text
            } else {
                var values = ints(record.computeIfAbsent(f.name(),
                        k -> new ArrayList<Integer>()));
                while (in.pos < end) {
                    values.add((int) readVarint(in)); //@d_unpack
                }
            }
            in.pos = end;
        }
        for (Field f : schema) {
            if (!record.containsKey(f.name())) { //@d_default
                Object d = f.type().equals("int32[]") ? List.of() : f.def();
                record.put(f.name(), d); //@d_default
            }
        }
        return record; //@d_done
    }
    // endregion

    // region read_varint
    /** Seven bits per byte, lowest group first. */
    static long readVarint(Cursor in) {
        long n = 0;
        int shift = 0;
        while (true) {
            int b = in.next(); //@v_byte
            n |= (long) (b & 0x7F) << shift; //@v_bits
            shift += 7;
            if (b < 0x80) { // top bit clear: the last byte //@v_stop
                return n; //@v_stop
            }
        }
    }
    // endregion

    // region skip
    /** Steps over a field this reader does not know. */
    static void skip(Cursor in, int wire) {
        switch (wire) {
            case VARINT -> readVarint(in); //@s_varint
            case LEN -> {
                int size = (int) readVarint(in); //@s_len
                in.pos += size; //@s_jump
            }
            case I64 -> in.pos += 8;
            case I32 -> in.pos += 4;
            default -> throw new IllegalArgumentException("wire " + wire);
        }
    }
    // endregion

    // region encode_avro
    /** Avro-style: values only, in schema order. */
    public static byte[] encodeAvro(Map<String, Object> record,
            List<Field> schema) {
        var out = new ByteArrayOutputStream();
        for (Field f : schema) { //@a_field
            writeValue(out, f.type(), record.get(f.name())); //@a_field
        }
        return out.toByteArray(); //@a_done
    }
    // endregion

    // region write_value
    /** One Avro value. Every number is zigzag, then varint. */
    static void writeValue(ByteArrayOutputStream out, String type,
            Object value) {
        switch (type) {
            case "int" -> writeVarint(out, zigzag((Integer) value)); //@a_int
            case "string" -> {
                byte[] data = bytesOf(value);
                writeVarint(out, zigzag(data.length)); //@a_len
                out.writeBytes(data); //@a_bytes
            }
            case "string?" -> { // a union of null and string
                if (value == null) {
                    writeVarint(out, zigzag(0)); // branch 0: null //@a_branch
                } else {
                    writeVarint(out, zigzag(1)); // branch 1 //@a_branch
                    writeValue(out, "string", value);
                }
            }
            default -> { // int[]: one block of items, then a zero count
                List<Integer> items = ints(value);
                if (!items.isEmpty()) {
                    writeVarint(out, zigzag(items.size())); //@a_count
                    for (int v : items) {
                        writeVarint(out, zigzag(v)); //@a_item
                    }
                }
                writeVarint(out, 0); //@a_end
            }
        }
    }
    // endregion

    // region read_avro
    /** Reads in the writer's order; keeps fields by name. */
    public static Map<String, Object> readAvro(byte[] data,
            List<Field> writer, List<Field> reader) {
        Map<String, Field> wanted = new HashMap<>();
        for (Field f : reader) {
            wanted.put(f.name(), f);
        }
        Map<String, Object> record = new LinkedHashMap<>();
        var in = new Cursor(data);
        for (Field f : writer) {
            Object value = readValue(in, f.type()); //@r_read
            Field mine = wanted.get(f.name()); //@r_match
            if (mine == null) {
                continue; // not in the reader: read, then dropped //@r_drop
            }
            if (!mine.type().equals(f.type())) { // Avro allows int to long
                throw new IllegalArgumentException(f.name() + ": types");
            }
            record.put(f.name(), value); //@r_keep
        }
        for (Field f : reader) {
            if (record.containsKey(f.name())) {
                continue;
            }
            if (f.def() == MISSING) { //@r_missing
                throw new IllegalArgumentException(f.name() + ": no default"); //@r_error
            }
            record.put(f.name(), f.def()); //@r_default
        }
        return record; //@r_done
    }
    // endregion

    // region read_value
    /** One Avro value of the given type. */
    static Object readValue(Cursor in, String type) {
        long n = readVarint(in); //@r_varint
        switch (type) {
            case "int":
                return (int) unzigzag(n); //@r_int
            case "string?":
                if (unzigzag(n) == 0) {
                    return null; //@r_null
                }
                return readValue(in, "string"); //@r_branch
            case "string": {
                int end = in.pos + (int) unzigzag(n);
                String s = utf8(in.data, in.pos, end); //@r_text
                in.pos = end; //@r_text
                return s;
            }
            default: { // int[]: blocks, then a zero count
                List<Integer> items = new ArrayList<>();
                long count = unzigzag(n);
                while (count != 0) { //@r_block
                    if (count < 0) { // a byte size follows
                        count = -count;
                        readVarint(in);
                    }
                    for (long i = 0; i < count; i++) {
                        items.add((int) unzigzag(readVarint(in))); //@r_item
                    }
                    count = unzigzag(readVarint(in)); //@r_block
                }
                return items; //@r_end
            }
        }
    }
    // endregion

    // region encode_json
    /** Names and values as text, for comparison. */
    public static byte[] encodeJson(Map<String, Object> record,
            List<Field> schema) {
        var parts = new ArrayList<String>();
        for (Field f : schema) {
            Object value = record.get(f.name());
            if (value != null) { //@j_field
                parts.add(quote(f.name()) + ":" + json(value)); //@j_field
            }
        }
        String text = "{" + String.join(",", parts) + "}";
        return text.getBytes(StandardCharsets.UTF_8); //@j_done
    }
    // endregion

    // region read_json
    /** Matches keys by name. There is no schema in the data. */
    public static Map<String, Object> readJson(byte[] data,
            List<Field> reader) {
        Map<String, Field> wanted = new HashMap<>();
        for (Field f : reader) {
            wanted.put(f.name(), f);
        }
        Map<String, Object> record = new LinkedHashMap<>();
        for (var e : parseJson(data).entrySet()) { //@j_key
            if (!wanted.containsKey(e.getKey())) { //@j_key
                continue; // unknown key: ignored //@j_skip
            }
            record.put(e.getKey(), e.getValue()); //@j_keep
        }
        for (Field f : reader) {
            record.putIfAbsent(f.name(), f.def()); //@j_default
        }
        return record; //@j_end
    }
    // endregion

    // ---- a minimal JSON writer and reader for this record's types ----

    static String json(Object v) {
        if (v instanceof String s) {
            return quote(s);
        }
        if (v instanceof List<?> list) {
            var parts = new ArrayList<String>();
            for (Object o : list) {
                parts.add(json(o));
            }
            return "[" + String.join(",", parts) + "]";
        }
        return String.valueOf(v);
    }

    static String quote(String s) {
        var b = new StringBuilder("\"");
        for (char c : s.toCharArray()) {
            switch (c) {
                case '"' -> b.append("\\\"");
                case '\\' -> b.append("\\\\");
                case '\n' -> b.append("\\n");
                default -> {
                    if (c < 0x20 || c > 0x7E) {
                        b.append(String.format("\\u%04x", (int) c));
                    } else {
                        b.append(c);
                    }
                }
            }
        }
        return b.append('"').toString();
    }

    static Map<String, Object> parseJson(byte[] data) {
        var p = new JsonParser(new String(data, StandardCharsets.UTF_8));
        @SuppressWarnings("unchecked")
        var map = (Map<String, Object>) p.value();
        return map;
    }

    /** Objects, arrays, strings, integers and null: enough for this page. */
    static final class JsonParser {
        final String s;
        int i;

        JsonParser(String s) {
            this.s = s;
        }

        void space() {
            while (i < s.length() && Character.isWhitespace(s.charAt(i))) {
                i++;
            }
        }

        Object value() {
            space();
            char c = s.charAt(i);
            if (c == '{') {
                Map<String, Object> m = new LinkedHashMap<>();
                i++;
                space();
                if (s.charAt(i) == '}') {
                    i++;
                    return m;
                }
                while (true) {
                    space();
                    String k = (String) value();
                    space();
                    i++; // ':'
                    m.put(k, value());
                    space();
                    if (s.charAt(i++) == '}') {
                        return m;
                    }
                }
            }
            if (c == '[') {
                List<Object> list = new ArrayList<>();
                i++;
                space();
                if (s.charAt(i) == ']') {
                    i++;
                    return list;
                }
                while (true) {
                    list.add(value());
                    space();
                    if (s.charAt(i++) == ']') {
                        return list;
                    }
                }
            }
            if (c == '"') {
                var b = new StringBuilder();
                i++;
                while (s.charAt(i) != '"') {
                    char ch = s.charAt(i++);
                    if (ch != '\\') {
                        b.append(ch);
                        continue;
                    }
                    char e = s.charAt(i++);
                    switch (e) {
                        case 'n' -> b.append('\n');
                        case 't' -> b.append('\t');
                        case 'r' -> b.append('\r');
                        case 'b' -> b.append('\b');
                        case 'f' -> b.append('\f');
                        case 'u' -> {
                            b.append((char) Integer.parseInt(s.substring(i, i + 4), 16));
                            i += 4;
                        }
                        default -> b.append(e);
                    }
                }
                i++;
                return b.toString();
            }
            if (s.startsWith("null", i)) {
                i += 4;
                return null;
            }
            int from = i;
            while (i < s.length() && "-0123456789".indexOf(s.charAt(i)) >= 0) {
                i++;
            }
            return Integer.parseInt(s.substring(from, i));
        }
    }
}
