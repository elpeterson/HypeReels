Run the full HypeReels engineering pipeline for the following request:

$ARGUMENTS

Follow these steps in order:

1. Use the @product-owner agent to translate the request into user stories in docs/user-stories.md. Wait for user stories to be complete before proceeding.

2. Use the @architect agent to read the user stories and design the system in docs/architecture.md. Wait for architecture to be complete before proceeding.

3. The following three agents can work in parallel — invoke all three:
   - @frontend-engineer — implement the UI
   - @backend-engineer — implement the API and business logic
   - @ai-ml-engineer — implement the ML pipelines

4. Use the @qa-engineer agent to write the test plan and validate acceptance criteria.

5. Use the @devops-engineer agent to set up CI/CD and infrastructure.

After each step, summarize what was produced and what comes next.
