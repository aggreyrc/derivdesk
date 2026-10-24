import { readFileSync } from "node:fs";

// A deliberately small parser for packages/db/prisma/schema.prisma — enough to compare what the
// schema SAYS against what the hand-written SQL migrations actually BUILT (this sandbox can't run
// `prisma migrate diff`, so the migrations were authored by hand and could silently drift).

export interface ParsedField {
  name: string;
  column: string;
  type: string;
  optional: boolean;
  isId: boolean;
  isUnique: boolean;
  hasDefault: boolean;
}
export interface ParsedRelation {
  column: string;
  targetTable: string;
  onDelete: "Cascade" | "Restrict" | "SetNull" | "NoAction";
}
export interface ParsedModel {
  name: string;
  table: string;
  fields: ParsedField[]; // scalar + enum columns only
  relations: ParsedRelation[];
  uniques: string[][]; // lists of COLUMN names
  indexes: string[][];
}
export interface ParsedSchema {
  models: ParsedModel[];
  enums: Record<string, string[]>;
}

const SCALARS = new Set(["String", "Int", "BigInt", "Float", "Decimal", "Boolean", "DateTime", "Json", "Bytes"]);

export function parseSchema(path: string): ParsedSchema {
  const src = readFileSync(path, "utf8");
  const enums: Record<string, string[]> = {};
  for (const m of src.matchAll(/^enum\s+(\w+)\s*\{([\s\S]*?)^\}/gm)) {
    enums[m[1]!] = m[2]!
      .split("\n")
      .map((l) => l.replace(/\/\/.*$/, "").trim())
      .filter(Boolean)
      .map((l) => l.split(/\s+/)[0]!);
  }

  const modelBlocks = [...src.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)].map((m) => ({ name: m[1]!, body: m[2]! }));
  const tableOf = new Map<string, string>();
  for (const b of modelBlocks) tableOf.set(b.name, /@@map\("([^"]+)"\)/.exec(b.body)?.[1] ?? b.name);

  const models: ParsedModel[] = modelBlocks.map(({ name, body }) => {
    const lines = body.split("\n").map((l) => l.replace(/\/\/.*$/, "").trimEnd());
    const fields: ParsedField[] = [];
    const relations: ParsedRelation[] = [];
    const uniques: string[][] = [];
    const indexes: string[][] = [];
    const columnOf = new Map<string, string>();
    // "occurredAt(sort: Desc)" -> the column behind `occurredAt`
    const colName = (s: string) => {
      const f = s.trim().replace(/\(.*\)$/, "");
      return columnOf.get(f) ?? f;
    };

    const raw: Array<{ name: string; type: string; list: boolean; optional: boolean; attrs: string }> = [];
    for (const line of lines) {
      const t = line.trim();
      if (!t || t.startsWith("@@")) continue;
      const m = /^(\w+)\s+(\w+)(\[\])?(\?)?\s*(.*)$/.exec(t);
      if (m) raw.push({ name: m[1]!, type: m[2]!, list: !!m[3], optional: !!m[4], attrs: m[5] ?? "" });
    }
    for (const f of raw) {
      if (SCALARS.has(f.type) || enums[f.type]) columnOf.set(f.name, /@map\("([^"]+)"\)/.exec(f.attrs)?.[1] ?? f.name);
    }
    for (const f of raw) {
      if (f.list) continue;
      if (SCALARS.has(f.type) || enums[f.type]) {
        fields.push({
          name: f.name,
          column: columnOf.get(f.name)!,
          type: f.type,
          optional: f.optional,
          isId: /@id\b/.test(f.attrs),
          isUnique: /@unique\b/.test(f.attrs),
          hasDefault: /@default\(/.test(f.attrs),
        });
      } else if (tableOf.has(f.type) && /@relation\(/.test(f.attrs)) {
        const fieldsList = /fields:\s*\[([^\]]+)\]/.exec(f.attrs)?.[1];
        if (!fieldsList) continue; // the other side of the relation
        const od = /onDelete:\s*(\w+)/.exec(f.attrs)?.[1] as ParsedRelation["onDelete"] | undefined;
        // Prisma's documented defaults: required relation -> Restrict, optional -> SetNull.
        const onDelete = od ?? (f.optional ? "SetNull" : "Restrict");
        relations.push({ column: columnOf.get(fieldsList.trim())!, targetTable: tableOf.get(f.type)!, onDelete });
      }
    }
    for (const m of body.matchAll(/@@unique\(\[([^\]]+)\]/g)) uniques.push(m[1]!.split(",").map((s) => colName(s)));
    for (const m of body.matchAll(/@@index\(\[([^\]]+)\]/g)) indexes.push(m[1]!.split(",").map((s) => colName(s)));
    for (const f of fields) if (f.isUnique) uniques.push([f.column]);

    return { name, table: tableOf.get(name)!, fields, relations, uniques, indexes };
  });

  return { models, enums };
}
