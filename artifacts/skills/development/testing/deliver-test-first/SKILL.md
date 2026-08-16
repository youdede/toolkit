---
name: deliver-test-first
description: Implement features, bug fixes, refactors, and behavior changes through a verified red-green-refactor loop using the repository's own test stack. Use when code behavior will change and regression evidence is required before completion.
---

# Deliver test first

## Contract

Prove each behavior change with an observable failing test before implementation, then keep the smallest relevant suite green. A test that never failed for the expected reason is not regression evidence.

## Discover the local contract

Before writing a test, inspect:

- repository instructions and CI workflows;
- build manifests and checked-in wrappers;
- existing test locations, names, fixtures, and helpers;
- the narrow command for one test and the broader command required before completion.

Do not assume `npm test`, a framework, or a directory layout.

## Slice the behavior

Describe one externally observable outcome and its boundary cases. Choose the lowest test level that proves it:

- unit for pure logic;
- integration for a meaningful process, storage, or service boundary;
- end-to-end only for a critical user journey that lower levels cannot prove.

For a bug, write a regression that reproduces the reported failure. For legacy code without a safe seam, add a characterization test around current behavior before refactoring.

## Red

1. Write one test with a behavior-focused name.
2. Prefer real collaborators or small fakes; mock only uncontrollable or expensive boundaries.
3. Run the focused command.
4. Confirm the test fails, not merely crashes during setup.
5. Confirm the failure message points to the missing or broken behavior.

If it passes immediately, correct the test or document that the behavior already exists. Do not proceed as if red occurred.

## Green

1. Make the smallest production change that satisfies the failing behavior.
2. Run the focused test.
3. Run nearby tests that share the changed boundary.
4. Do not add speculative options or adjacent refactors.

## Refactor

Improve names, duplication, and structure only while tests are green. Re-run after each meaningful refactor. Add the next failing test for the next behavior slice.

Use [the test quality checklist](references/test-quality.md) before calling the test durable.

## Completion evidence

Report:

- the behavior proved;
- the red command and expected failure;
- the green command and passing result;
- the broader verification command;
- anything intentionally untested and why.

## Exceptions

Test-first may be disproportionate for documentation, static content, generated outputs, or disposable exploration. State the exception before implementation and ask when the risk or user expectation is unclear. Throw away exploratory production code before beginning the verified change.

## Refusals

- Do not write a test that only mirrors internal calls or mocks the behavior under test.
- Do not weaken assertions, skip tests, or change test configuration to manufacture green.
- Do not delete pre-existing implementation merely to recreate ritual red without user approval.
- Do not claim coverage, quality, or completion from one focused passing test alone.
