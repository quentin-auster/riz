import { render, screen } from "@testing-library/svelte";
import { expect, test } from "vitest";
import Page from "./+page.svelte";

const filters = {
  application: "crm-prod",
  actor: "",
  action: "models.rollback",
  from: "",
  to: "",
};
const event = {
  id: "7",
  time: "2026-01-01T00:00:00.000Z",
  actor: "dev-admin",
  action: "models.rollback",
  application: "crm-prod",
  requestId: "req_1",
};

test("each audit event is listed with its actor and action", () => {
  render(Page, {
    data: { filters, items: [event], nextCursor: null, filterError: null },
  } as never);
  expect(screen.getByText("dev-admin")).toBeInTheDocument();
  expect(
    screen.getByRole("cell", { name: "models.rollback" }),
  ).toBeInTheDocument();
  expect(screen.queryByText("Next page")).toBeNull();
});

test("the next page keeps the filters that were applied", () => {
  render(Page, {
    data: { filters, items: [event], nextCursor: "abc", filterError: null },
  } as never);
  expect(screen.getByRole("link", { name: "Next page" })).toHaveAttribute(
    "href",
    "?application=crm-prod&action=models.rollback&cursor=abc",
  );
});

test("a bad filter is reported", () => {
  render(Page, {
    data: {
      filters,
      items: [],
      nextCursor: null,
      filterError: "to is not a valid date and time.",
    },
  } as never);
  expect(screen.getByRole("alert")).toHaveTextContent("not a valid date");
});
