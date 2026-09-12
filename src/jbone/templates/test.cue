// jbone template: test
keywords: ["test", "spec", "cover", "verify", "regression"]
harness: "opencode"
objective: "add/repair tests for: %(phrase)s"
code: """
# Code Mode: test pass
npx vitest run --reporter=dot
"""
