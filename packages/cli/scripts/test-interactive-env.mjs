// Ink 5 suppresses dynamic terminal frames whenever it detects CI, even when
// tests provide interactive TTY streams. The CLI test suite exercises Glossa's
// interactive terminal behavior, so make the test process model that environment
// before Ink is imported.
process.env.CI = "false";
