import { render, screen } from "@testing-library/svelte";
import { expect, test } from "vitest";
import List from "./+page.svelte";
import Detail from "./[id]/+page.svelte";

const crm = {
  id: "crm-prod",
  name: "crm",
  environment: "prod",
  createdAt: "2026-01-01T00:00:00.000Z",
};

test("the list links each application to its detail page", () => {
  render(List, {
    data: { q: "", items: [crm], nextCursor: null },
  } as never);
  expect(screen.getByRole("link", { name: "crm" })).toHaveAttribute(
    "href",
    "/applications/crm-prod",
  );
  expect(screen.queryByText("Next page")).toBeNull();
});

test("the list says so when there are no applications, and offers the next page", () => {
  render(List, {
    data: { q: "zzz", items: [], nextCursor: "abc def" },
  } as never);
  expect(screen.getByText("No applications.")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Next page" })).toHaveAttribute(
    "href",
    "?cursor=abc%20def",
  );
});

test("the detail shows the environment, the active model and prior models", () => {
  render(Detail, {
    data: {
      application: crm,
      active: { id: "02", createdAt: "t2", active: true },
      prior: [{ id: "01", createdAt: "t1", active: false }],
    },
  } as never);
  expect(screen.getByText("prod")).toBeInTheDocument();
  expect(screen.getByText("02")).toBeInTheDocument();
  expect(screen.getByText(/^01/)).toBeInTheDocument();
});

test("the detail says there is no active model when none is bound", () => {
  render(Detail, {
    data: { application: crm, active: null, prior: [] },
  } as never);
  expect(screen.getByText("None")).toBeInTheDocument();
  expect(screen.getByText("No prior models.")).toBeInTheDocument();
});
