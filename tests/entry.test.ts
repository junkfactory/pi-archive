import { describe, expect, it } from "vitest";
import entry from "../extensions/index.js";
import extension from "../src/index.js";

describe("package entry", () => {
	it("re-exports the extension factory pi loads", () => {
		expect(entry).toBe(extension);
		expect(typeof entry).toBe("function");
	});
});
