import { expect, it } from "vitest";
import { canReviewAccess } from "./admin-access";
import { renderToStaticMarkup } from "react-dom/server";
import { AdminAccess } from "./AdminAccess";
import { createElement } from "react";

it("keeps merchant actions disabled until session capability is known", () => {
  expect(canReviewAccess(null)).toBe(false);
  expect(canReviewAccess({ hosted: true, configured: true, authenticated: false, canReview: false })).toBe(false);
  expect(canReviewAccess({ hosted: true, configured: true, authenticated: true, canReview: true })).toBe(true);
  expect(canReviewAccess({ hosted: false, configured: true, authenticated: true, canReview: true })).toBe(true);
});

it("renders hosted sign-in status without passing a credential as a prop", () => {
  const html = renderToStaticMarkup(createElement(AdminAccess, { state: { hosted: true, configured: true, authenticated: false, canReview: false }, onChange: () => {} }));
  expect(html).toContain("Administrator password");
  expect(html).toContain("Merchant approval and rejection require sign-in.");
  expect(html).not.toContain("value=\"password\"");
});
