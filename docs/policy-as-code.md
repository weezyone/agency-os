# Action policy as code

## Purpose

Approval requirements are tenant-owned configuration, not hard-coded UI behavior. A policy determines whether an action is allowed, who may approve it, how many approvals are required, whether requester/approver separation is mandatory, and which roles may execute it.

## Document contract

```yaml
apiVersion: agencyos/v1
kind: ActionPolicy
defaultEffect:
  deny: false
  requiredApprovals: 1
  requireSeparateApprover: true
  approverRoles: [reviewer, admin, owner]
  executorRoles: [operator, admin, owner]
rules:
  - id: high-risk-two-person
    description: High-risk mutations require two approvers.
    match:
      risks: [high]
    effect:
      deny: false
      requiredApprovals: 2
      requireSeparateApprover: true
      approverRoles: [reviewer, admin, owner]
      executorRoles: [operator, admin, owner]
```

All matching rules are considered. A matching deny effect takes precedence; otherwise the first matching rule wins. The default effect applies when no rule matches.

## Immutable decision snapshot

When an action is proposed, AgencyOS stores:

- Policy ID
- Policy version
- SHA-256 policy checksum
- Matched rule ID
- Denial result
- Approval quorum
- Separation requirement
- Approver roles
- Executor roles

Approvals and execution use this snapshot. Activating a new policy does not alter an in-flight proposal.

## Recommended progression

1. Start with the built-in safe default.
2. Export the active policy before editing.
3. Create a new draft version.
4. Review deny rules before approval rules.
5. Activate the new version.
6. Propose a low-risk test action and inspect its snapshot.
7. Verify high-risk publication requires the expected quorum.
8. Retain old versions for audit reconstruction.
