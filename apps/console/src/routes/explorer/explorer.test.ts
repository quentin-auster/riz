import { render, screen } from "@testing-library/svelte";
import { expect, test } from "vitest";
import Page from "./+page.svelte";

test("the decision, model and request id are shown", () => {
  render(Page, {
    form: {
      status: 200,
      query: {},
      answer: { status: "deny", modelId: "m1", requestId: "req_1" },
    },
  } as never);
  const result = screen.getByRole("status");
  expect(result).toHaveTextContent("deny");
  expect(result).toHaveTextContent("m1");
  expect(result).toHaveTextContent("req_1");
});

test("a refusal from the API is shown and keeps the query filled in", () => {
  render(Page, {
    form: {
      status: 403,
      error: "Missing scope explorer:check.",
      query: { principal: "anne" },
    },
  } as never);
  expect(screen.getByRole("alert")).toHaveTextContent("explorer:check");
  expect(screen.getByLabelText("Principal")).toHaveValue("anne");
});
