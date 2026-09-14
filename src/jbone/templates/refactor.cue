// jbone template: refactor
keywords: ["refactor", "clean", "simplify", "tidy", "restructure"]
harness: "opencode"
objective: "refactor: %(phrase)s"
code: """
# Code Mode: refactor pass
rg -n "%(phrase)s" src/ && echo "review hits above"
"""
