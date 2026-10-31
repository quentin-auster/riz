import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/svelte";
import { afterEach } from "vitest";

// Globals are off, so testing-library does not unmount between tests on its own.
afterEach(cleanup);
