# Incident Report Requirements

Incident reports should document root cause clearly enough that the next operator can distinguish symptoms from the
process or configuration failure that must change.

## Required Sections

- Impact summary
- Root cause
- Five Whys
- Contributing factors
- What was not the root cause
- Recovery actions
- Final verification
- Follow-up actions

## Five Whys

Use Five Whys to trace from user-visible impact to the process, configuration, capacity, or ownership failure that can
be changed. Start with the actual impact, ask why that happened, then ask why the previous answer happened. Stop when
the chain reaches an actionable system cause.

Keep the analysis blameless. A person or team is not a root cause; if a human action appears in the chain, continue
asking why the system allowed or encouraged that action.

Five is a convention, not a hard limit. Use fewer or more questions when the evidence supports it, and split the chain
when the incident has multiple independent causes.

## References

- [Atlassian postmortem handbook](https://www.atlassian.com/incident-management/handbook/postmortems)
- [Atlassian 5 Whys guide](https://www.atlassian.com/incident-management/postmortem/5-whys)
