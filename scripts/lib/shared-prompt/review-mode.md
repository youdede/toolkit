## Review mode

The parent supplies either a change (a diff or two named revisions) or a partition (a set of paths to review as they stand). State the mode where your reply reports the reviewed scope.

A partition has no baseline. Read every requirement of this brief that names a change, a baseline, or an old and a new state as a requirement about the code as it stands, and treat every supplied path as in scope. A missing baseline, intent, invariant, contract, or policy is not a reason to stop: derive it from the code, tests, and documents inside the partition, label it `inferred` with its location, and rate a finding that rests only on an inferred requirement `Supported` at most. Ask the parent only for what the partition gives no way to derive.

In both modes, name every supplied path you did not open, with the reason. An unopened path is unreviewed, not clean.
