// jbone template: ship
keywords: ["ship", "release", "seal", "tag", "deploy"]
harness: "hermes"
objective: "ship: %(phrase)s"
code: """
# Code Mode: ship pass
npm test && timmy seal run --meta subject="ship %(phrase)s"
"""
