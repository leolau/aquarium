import { describe, expect, it } from "vitest";

import { splitDataAnswer } from "./data-answer";

const block = (json: string) => `38 were late.\n\n\`\`\`data-answer\n${json}\n\`\`\``;

describe("splitDataAnswer", () => {
  it("strips a trailing data-answer block and reads it", () => {
    const { text, answer } = splitDataAnswer(
      block('{"source_id":"s1","source":"HSDOS WMS","version":3,"tables":["shipments"],"question":"q","sql":"select 1","undescribed":["returns"]}'),
    );
    expect(text).toBe("38 were late.");
    expect(answer).toMatchObject({ source_id: "s1", version: 3, tables: ["shipments"], undescribed: ["returns"] });
  });

  it("leaves the text alone when the block is broken or incomplete", () => {
    for (const json of ["{not json", '{"source":"x"}', "[1]"]) {
      const content = block(json);
      expect(splitDataAnswer(content)).toEqual({ text: content, answer: null });
    }
  });

  it("ignores a data-answer block that is not at the end", () => {
    const content = `${block('{"source_id":"s1","sql":"x"}')}\nmore`;
    expect(splitDataAnswer(content).answer).toBeNull();
  });

  it("treats a missing version as no approved dictionary", () => {
    expect(splitDataAnswer(block('{"source_id":"s1","sql":"x","version":null}')).answer?.version).toBeNull();
  });
});
