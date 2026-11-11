"""Protobuf-style and Avro-style encoding of one small record."""
import json

VARINT, I64, LEN, I32 = 0, 1, 2, 5  # wire types
MISSING = object()  # an Avro reader field with no default


class Field:
    """One field of a schema: number, name, type and default."""

    def __init__(self, num, name, type_, default=None):
        self.num = num
        self.name = name
        self.type = type_
        self.default = default


def wire_type(f):
    """Protobuf wire type for a field's type."""
    return LEN if f.type in ('string', 'int32[]') else VARINT


def to_int32(n):
    """Keep the low 32 bits, as a signed number."""
    n &= 0xFFFFFFFF
    return n - (1 << 32) if n >= 1 << 31 else n


# region encode
def encode(record, schema):
    """Protobuf-style: a key before every value."""
    out = bytearray()
    for f in schema:
        value = record.get(f.name)  #@e_field
        if value is None or value == []:
            continue  # unset or empty: no bytes at all  #@e_absent
        wire = wire_type(f)
        write_varint(out, f.num << 3 | wire)  #@e_key
        if f.type == 'string':
            data = value.encode('utf-8')
            write_varint(out, len(data))  #@e_len
            out += data  #@e_bytes
        elif f.type == 'int32[]':
            packed = bytearray()
            for v in value:
                write_varint(packed, v)  #@e_pack
            write_varint(out, len(packed))  #@e_len
            out += packed  #@e_bytes
        elif f.type == 'sint32':
            write_varint(out, zigzag(value))  #@e_zigzag
        else:
            write_varint(out, value)  #@e_value
    return bytes(out)  #@e_done
# endregion


# region write_varint
def write_varint(out, n):
    """Seven bits per byte, lowest group first."""
    if n < 0:
        n += 1 << 64  # a negative int32 takes ten bytes
    while n >= 0x80:  #@w_more
        out.append(n & 0x7F | 0x80)  # top bit set: more follow  #@w_more
        n >>= 7  #@w_more
    out.append(n)  # top bit clear: the last byte  #@w_last
# endregion


# region zigzag
def zigzag(n):
    """0, -1, 1, -2 become 0, 1, 2, 3."""
    return (n << 1) ^ (n >> 31)  #@z_enc


def unzigzag(n):
    """The inverse: 0, 1, 2, 3 become 0, -1, 1, -2."""
    return (n >> 1) ^ -(n & 1)  #@z_dec
# endregion


# region decode
def decode(data, schema):
    """Read keys; look each field number up in the reader's schema."""
    by_num = {f.num: f for f in schema}
    record, pos = {}, 0
    while pos < len(data):  #@d_loop
        key, pos = read_varint(data, pos)  #@d_key
        num, wire = key >> 3, key & 7  #@d_split
        f = by_num.get(num)  #@d_lookup
        if f is None or wire != wire_type(f):  #@d_lookup
            pos = skip(data, pos, wire)  # unknown: skip it  #@d_unknown
            continue
        if wire == VARINT:
            n, pos = read_varint(data, pos)  #@d_varint
            if f.type == 'sint32':
                n = unzigzag(n)  #@d_zigzag
            record[f.name] = to_int32(n)  #@d_varint
            continue
        size, pos = read_varint(data, pos)  #@d_len
        end = pos + size  #@d_len
        if f.type == 'string':
            record[f.name] = data[pos:end].decode('utf-8')  #@d_text
        else:
            values = record.setdefault(f.name, [])
            while pos < end:
                v, pos = read_varint(data, pos)  #@d_unpack
                values.append(to_int32(v))  #@d_unpack
        pos = end
    for f in schema:
        if f.name not in record:  #@d_default
            record[f.name] = [] if f.type == 'int32[]' else f.default  #@d_default
    return record  #@d_done
# endregion


# region read_varint
def read_varint(data, pos):
    """Seven bits per byte, lowest group first."""
    n = shift = 0
    while True:
        b = data[pos]  #@v_byte
        pos += 1
        n |= (b & 0x7F) << shift  #@v_bits
        shift += 7
        if b < 0x80:  # top bit clear: the last byte  #@v_stop
            return n, pos  #@v_stop
# endregion


# region skip
def skip(data, pos, wire):
    """Step over a field this reader does not know."""
    if wire == VARINT:
        _, pos = read_varint(data, pos)  #@s_varint
        return pos  #@s_varint
    if wire == LEN:
        size, pos = read_varint(data, pos)  #@s_len
        return pos + size  #@s_jump
    if wire == I64:
        return pos + 8
    if wire == I32:
        return pos + 4
    raise ValueError('wire type %d' % wire)
# endregion


# region encode_avro
def encode_avro(record, schema):
    """Avro-style: values only, in schema order."""
    out = bytearray()
    for f in schema:  #@a_field
        write_value(out, f.type, record.get(f.name))  #@a_field
    return bytes(out)  #@a_done
# endregion


# region write_value
def write_value(out, type_, value):
    """One Avro value. Every number is zigzag, then varint."""
    if type_ == 'int':
        write_varint(out, zigzag(value))  #@a_int
    elif type_ == 'string':
        data = value.encode('utf-8')
        write_varint(out, zigzag(len(data)))  #@a_len
        out += data  #@a_bytes
    elif type_ == 'string?':  # a union of null and string
        if value is None:
            write_varint(out, zigzag(0))  # branch 0: null  #@a_branch
        else:
            write_varint(out, zigzag(1))  # branch 1: string  #@a_branch
            write_value(out, 'string', value)
    else:  # int[]: one block of items, then a zero count
        if value:
            write_varint(out, zigzag(len(value)))  #@a_count
            for v in value:
                write_varint(out, zigzag(v))  #@a_item
        write_varint(out, 0)  #@a_end
# endregion


# region read_avro
def read_avro(data, writer, reader):
    """Read in the writer's order; keep fields by name."""
    wanted = {f.name: f for f in reader}
    record, pos = {}, 0
    for f in writer:
        value, pos = read_value(data, pos, f.type)  #@r_read
        mine = wanted.get(f.name)  #@r_match
        if mine is None:
            continue  # not in the reader: read, then dropped  #@r_drop
        if mine.type != f.type:  # real Avro allows int to long
            raise ValueError(f.name + ': types differ')
        record[f.name] = value  #@r_keep
    for f in reader:
        if f.name in record:
            continue
        if f.default is MISSING:  #@r_missing
            raise ValueError(f.name + ': no default')  #@r_error
        record[f.name] = f.default  #@r_default
    return record  #@r_done
# endregion


# region read_value
def read_value(data, pos, type_):
    """One Avro value of the given type."""
    n, pos = read_varint(data, pos)  #@r_varint
    if type_ == 'int':
        return unzigzag(n), pos  #@r_int
    if type_ == 'string?':
        if unzigzag(n) == 0:
            return None, pos  #@r_null
        return read_value(data, pos, 'string')  #@r_branch
    if type_ == 'string':
        end = pos + unzigzag(n)
        return data[pos:end].decode('utf-8'), end  #@r_text
    items, count = [], unzigzag(n)  # int[]: blocks, then 0
    while count != 0:  #@r_block
        if count < 0:  # a negative count has a byte size after it
            count = -count
            _, pos = read_varint(data, pos)
        for _ in range(count):
            v, pos = read_varint(data, pos)  #@r_item
            items.append(unzigzag(v))  #@r_item
        n, pos = read_varint(data, pos)  #@r_block
        count = unzigzag(n)  #@r_block
    return items, pos  #@r_end
# endregion


# region encode_json
def encode_json(record, schema):
    """Names and values as text, for comparison."""
    parts = []
    for f in schema:
        value = record.get(f.name)
        if value is not None:  #@j_field
            text = json.dumps(value, separators=(',', ':'))
            parts.append(json.dumps(f.name) + ':' + text)  #@j_field
    return ('{' + ','.join(parts) + '}').encode('utf-8')  #@j_done
# endregion


# region read_json
def read_json(data, reader):
    """Match keys by name. There is no schema in the data."""
    wanted = {f.name: f for f in reader}
    record = {}
    for name, value in json.loads(data).items():  #@j_key
        if name not in wanted:  #@j_key
            continue  # unknown key: ignored  #@j_skip
        record[name] = value  #@j_keep
    for f in reader:
        if f.name not in record:
            record[f.name] = f.default  #@j_default
    return record  #@j_end
# endregion
