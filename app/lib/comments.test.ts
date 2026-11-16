import { describe, it, expect } from "vitest";
import { splitCommentText } from "./comments";

describe("splitCommentText", () => {
  it("returns plain text untouched", () => {
    expect(splitCommentText("just words")).toEqual([
      { type: "text", value: "just words" },
    ]);
  });

  it("splits out http and https links", () => {
    expect(splitCommentText("see https://a.dev/x and http://b.dev")).toEqual([
      { type: "text", value: "see " },
      { type: "link", value: "https://a.dev/x", href: "https://a.dev/x" },
      { type: "text", value: " and " },
      { type: "link", value: "http://b.dev", href: "http://b.dev" },
    ]);
  });

  it("leaves trailing punctuation out of the link", () => {
    expect(splitCommentText("(see https://a.dev/x).")).toEqual([
      { type: "text", value: "(see " },
      { type: "link", value: "https://a.dev/x", href: "https://a.dev/x" },
      { type: "text", value: ")." },
    ]);
  });

  it("never links non-http schemes", () => {
    const text = "javascript:alert(1) data:text/html,<b>x</b>";
    expect(splitCommentText(text)).toEqual([{ type: "text", value: text }]);
  });

  it("keeps HTML as plain text", () => {
    const text = "<script>alert(1)</script>";
    expect(splitCommentText(text)).toEqual([{ type: "text", value: text }]);
  });
});
