import { render, screen } from "@testing-library/svelte";
import { expect, test } from "vitest";
import Page from "./+page.svelte";

const models = [
  { id: "01OLD", createdAt: "t1", active: false },
  { id: "02NEW", createdAt: "t2", active: true },
];
const data = (canWrite: boolean, diff: unknown = null) => ({
  application: "crm-prod",
  models,
  nextCursor: null,
  canWrite,
  diff,
});

test("a caller who can write sees a roll back control for prior models only", () => {
  render(Page, { data: data(true) } as never);
  expect(screen.getAllByText("Roll back")).toHaveLength(1);
  expect(
    screen.getByRole("link", { name: "Compare with active" }),
  ).toHaveAttribute("href", "?application=crm-prod&from=01OLD&to=02NEW");
});

test("a caller who cannot write sees the history but no roll back control", () => {
  render(Page, { data: data(false) } as never);
  expect(screen.getByText("01OLD")).toBeInTheDocument();
  expect(screen.queryByText("Roll back")).toBeNull();
});

test("the diff shows removed and added lines", () => {
  render(Page, {
    data: data(false, {
      from: "01OLD",
      to: "02NEW",
      lines: [
        {
          kind: "del",
          text: "define viewer: [user] or editor or member from team",
        },
        { kind: "add", text: "define viewer: [user] or editor" },
      ],
    }),
  } as never);
  const diff = screen.getByLabelText("Model diff");
  expect(diff).toHaveTextContent(
    "- define viewer: [user] or editor or member from team",
  );
  expect(diff).toHaveTextContent("+ define viewer: [user] or editor");
});

test("a refused rollback shows the API's reason", () => {
  render(Page, {
    data: data(true),
    form: { status: 403, error: "Missing scope models:write." },
  } as never);
  expect(screen.getByRole("alert")).toHaveTextContent("models:write");
});
