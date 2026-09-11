# Deploy using the project's environment

Admin PRT's manual deployment omitted `environment`. The deployment entry point defaulted to `production`, although the selected project was a `preview` environment and its required Compose variables were stored there. The attempt failed while the previous successful preview deployment remained healthy.

Manual trigger and build/access now derive an omitted environment from the project's `environmentType`. An explicit mismatch fails with HTTP 400 / `PROJECT_ENVIRONMENT_MISMATCH` before source reconciliation, environment writes, or deployment creation. Project-level redeploy, rebuild-all, and refresh controls send their selected environment explicitly. Retrying an older mislabelled deployment reloads current variables from the project's actual environment instead of perpetuating the old row's incorrect scope. Frozen rollback requests still pass their explicit environment through the validation boundary.

Regression coverage exercises the real build-service entry points: preview/development/production defaults, mismatched scopes, build/access, and retrying an old mislabelled PRT attempt. Frontend tests verify all three manual actions' API payloads. The affected backend suite has 81 tests and the frontend request suite has four. API and Dashboard typechecks also pass. Publishing still requires the existing full release gate and both real-Docker suites; this note alone is not production acceptance.

No environment-variable values are copied between PRT and Production. The database schema and stored deployment history are unchanged.
