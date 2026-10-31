import { render, screen } from "@testing-library/svelte";
import { expect, test } from "vitest";
import Page from "./+page.svelte";

const data = (canWrite: boolean) => ({
  application: "crm-prod",
  object: "",
  relation: "",
  items: [{ subject: "user:anne", relation: "member", object: "team:eng" }],
  nextCursor: null,
  canWrite,
  filterError: null,
});

test("a caller who can write sees the grant form and a revoke control", () => {
  render(Page, { data: data(true) } as never);
  expect(screen.getByRole("button", { name: "Grant" })).toBeInTheDocument();
  expect(screen.getByText("Revoke")).toBeInTheDocument();
});

test("a caller who cannot write sees the tuples but no grant or revoke controls", () => {
  render(Page, { data: data(false) } as never);
  expect(screen.getByText("user:anne")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Grant" })).toBeNull();
  expect(screen.queryByText("Revoke")).toBeNull();
});

test("a successful change shows the audit event id", () => {
  render(Page, {
    data: data(true),
    form: {
      status: 200,
      message: "Relationship granted.",
      auditEventId: "evt-9",
    },
  } as never);
  expect(screen.getByRole("status")).toHaveTextContent("Audit event evt-9");
});

test("a refusal from the API is shown to the user", () => {
  render(Page, {
    data: data(true),
    form: { status: 403, error: "missing scope relationships:write" },
  } as never);
  expect(screen.getByRole("alert")).toHaveTextContent("relationships:write");
});
