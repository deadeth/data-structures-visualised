import type { Info } from '../../core/types';

export const info: Info = {
  summary:
    'Serialisation turns a record into bytes that another program, often a different version of it, can read back. JSON sends names and values as text. Protocol Buffers sends a small key before each value: the field number and how the value is laid out, so a reader can skip fields it does not know. Avro sends only the values, in schema order, and the reader resolves the writer\'s schema against its own by field name. The rules for changing a schema follow from those layouts.',
  watch: [
    'The record is id = 1337, name = "Ada", email unset and scores = [3, 7]. In protobuf it is 12 bytes: 08 B9 0A 12 03 41 64 61 22 02 03 07. As JSON it is 39.',
    'Each key byte is (field number << 3) | wire type. 08 is field 1, wire type 0 (varint). 12 is field 2, wire type 2 (a length, then bytes). The field name never travels.',
    'A varint stores 7 bits per byte, lowest group first. The top bit says whether another byte follows. 1337 is 10100111001 in binary: the low 7 bits, 0111001, go first with the top bit set (B9), then 0001010 with it clear (0A).',
    'email is unset, so nothing at all is written for it. Absent fields are free.',
    'Evolve old: a v1 reader meets field 5, which it has never heard of. Wire type 2 says a length follows, so it reads the length and jumps. That is forward compatibility.',
    'Evolve new: a v2 reader meets old data with no field 5. It takes the default, the empty string in proto3. That is backward compatibility.',
    'Break it with reuse: field 4 is given to a string. The old reader still thinks 4 is the packed scores, and "Ada" comes out as [65,100,97], with no error.',
    'Avro: 11 bytes with no keys. The reader walks the writer\'s schema to find each value, drops email because its own schema lacks it, and fills plan from its default, "free".',
    'Simplified: one record, four or five fields, one block per Avro array, and no nested messages, maps or 64-bit numbers. JSON is drawn as one box per field rather than one per byte. The protobuf bytes match the protobuf library and the Avro bytes match fastavro for this record.',
  ],
  complexity: [
    { op: 'Encode (protobuf, Avro)', average: 'O(n)', worst: 'O(n)', note: 'One pass over the fields. A varint costs one step per 7 bits, so a 32-bit number is at most 5 bytes, or 10 when an int32 is negative.' },
    { op: 'Decode (protobuf)', average: 'O(n)', worst: 'O(n)', note: 'One pass over the bytes. A field lookup by number is an array index or a switch in generated code.' },
    { op: 'Skip an unknown field', average: 'O(1) for a length', worst: 'O(k) for a varint', note: 'Length-delimited fields are skipped in one jump. A varint must be read byte by byte to find its end.' },
    { op: 'Avro schema resolution', average: 'O(fields) once', worst: 'O(fields) once', note: 'The writer-to-reader mapping depends only on the two schemas, so an implementation can work it out once and reuse it for every record.' },
    { op: 'Decode (JSON)', average: 'O(n)', worst: 'O(n)', note: 'Also linear, but every byte is text to tokenise, and numbers must be parsed from digits.' },
  ],
  space:
    'This record: 12 bytes in protobuf, 11 in Avro, 39 in compact JSON. Protobuf pays about one key byte per field present (two from field 16 to 2047). Avro pays nothing per field, but needs the writer\'s schema at hand: in a file it is written once in the header, and with Kafka it is a schema id in each message pointing at a registry. JSON repeats every name on every record.',
  usedIn: [
    {
      name: 'gRPC',
      how: 'Uses Protocol Buffers by default for both its interface definition language and its messages. A .proto file defines the service and the messages, and code is generated for each language.',
    },
    {
      name: 'Kafka with a schema registry',
      how: 'Confluent Schema Registry stores Avro, Protobuf and JSON Schema schemas under a subject, checks each new version against a compatibility mode (BACKWARD by default), and the serialiser puts a small schema id in front of each message instead of the schema.',
    },
    {
      name: 'Hadoop and data lakes',
      how: 'Avro object container files store the writer\'s schema once in the file header, followed by blocks of records. Readers get the schema from the file, so old files stay readable as the schema moves on.',
    },
    {
      name: 'Apache Thrift',
      how: 'Started at Facebook and now an Apache project. Like protobuf it tags each field with a number and generates code, and it also defines an RPC framework with several wire protocols, binary and compact among them.',
    },
    {
      name: 'Web and public APIs',
      how: 'Mostly JSON, often described by OpenAPI or JSON Schema, because any client can read it with no generated code and a person can read it in a log.',
    },
  ],
  reachFor: [
    'Protobuf for service-to-service calls, especially with gRPC: compact, fast, generated types, and safe evolution through field numbers.',
    'Avro for event streams and files: the smallest bytes, schemas that can be resolved by name, and a registry or file header to carry the writer\'s schema.',
    'JSON at the edges: browsers, public APIs, configuration and anything a person will read or a third party will call.',
    'Any binary format with a schema when many teams share data and must change it without stopping everyone at once.',
  ],
  costs: [
    'Binary formats are not readable in a log or with curl. You need the schema and a tool to look at the bytes.',
    'Protobuf trusts field numbers completely. Reuse one, or change a type to another with the same wire type, and old readers get wrong values with no error.',
    'Avro is useless without the writer\'s exact schema. Lose it, or read with the wrong one, and the bytes become nonsense.',
    'Code generation adds a build step, and the .proto or .avsc files become a shared dependency that teams must coordinate.',
    'JSON is bigger and slower to parse, has no single integer type (JavaScript reads every number as a 64-bit float, so integers above 2^53 lose precision), and has no binary type: bytes must go as Base64, a third bigger.',
  ],
  interview: [
    'Why not just JSON? Size: names repeat on every record, and 1337 is 4 bytes of text rather than 2. Parse cost: everything is text to scan. No schema: nothing checks the contract, so a renamed field just turns into a missing one. Numbers and binary: integers above 2^53 lose precision in JavaScript, and bytes need Base64.',
    'A schema is documentation and a contract at once. It says what each field means and which types are allowed, it generates the code, and a registry or a CI check can refuse a change that would break readers.',
    'Rules for protobuf evolution: never change or reuse a field number; add new fields with new numbers; when you delete one, mark its number and name reserved so nobody can take them again; do not change a type unless the protobuf documentation lists the two as compatible. int32 and sint32 are not.',
    'Forward compatibility means old code reads new data: unknown fields are skipped. Backward compatibility means new code reads old data: missing fields take defaults. A rolling upgrade needs both, because for a while old and new versions of a service write and read each other\'s messages.',
    'Wire types are what make skipping possible: 0 varint, 1 fixed 64 bits, 2 length-delimited, 5 fixed 32 bits. The reader does not need to know the field to know how long it is.',
    'Zigzag: a negative int32 is sign-extended to 64 bits and takes 10 bytes as a varint. sint32 maps 0, −1, 1, −2 to 0, 1, 2, 3 with (n << 1) ^ (n >> 31) first, so small negatives stay short. Avro zigzags every int and long.',
    'Avro has no tags in the data, so the reader needs the writer\'s schema. It resolves the two by field name: a writer field the reader lacks is read and dropped, a reader field the writer lacks takes the reader\'s default, and with no default the read fails. Add or remove only fields that have defaults.',
    'Schema registry compatibility modes, as Confluent defines them: BACKWARD, the default, means consumers on the new schema can read data written with the previous one. FORWARD means consumers on the previous schema can read data written with the new one. FULL means both. The _TRANSITIVE variants check against every earlier version, not just the last.',
    'Where each fits: protobuf with gRPC for RPC between services; Avro with Kafka and a registry, and in Hadoop-style files; Thrift where it is already the house standard for RPC; JSON for public APIs and anything a browser touches.',
    'Upgrade order follows the mode. With backward-compatible changes, upgrade consumers first, then producers. With forward-compatible changes, producers can go first.',
  ],
};
