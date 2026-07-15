import { expect, test } from "bun:test";
import { version } from "./index";

test("version is set", () => {
  expect(version()).toBe("0.1.0");
});
