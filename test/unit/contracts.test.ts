import { describe, expect, test } from "bun:test";
import { HOST_BRIDGE_VERSION } from "../../src/constants.ts";
import { isOmpHostBridgeV1, readHostBridge, requireHostBridge } from "../../src/contracts.ts";
import { createFakeHost } from "../helpers/fake-host.ts";

describe("OmpHostBridgeV1", () => {
	test("accepts a version-1 host", () => {
		const host = createFakeHost();
		expect(isOmpHostBridgeV1(host)).toBe(true);
		expect(requireHostBridge(host).version).toBe(HOST_BRIDGE_VERSION);
	});

	test("rejects a missing host", () => {
		expect(isOmpHostBridgeV1(undefined)).toBe(false);
		expect(readHostBridge(undefined)).toBeUndefined();
		expect(() => requireHostBridge(undefined)).toThrow(/host bridge v1/);
	});
});
