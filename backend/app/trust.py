"""Evidence-based policy trust ("earned autonomy") and relapse tracking.

Every automatic or operator-approved remediation is an experiment whose result
arrives later: it is a durable success only if the same fault does not return
on the same service within RELAPSE_WINDOW_SEC. A relapse, a failed action or a
failed verification counts against the (policy, service) pair.

Trust is the posterior mean of a Beta-Bernoulli model with a designer prior
(PRIOR_SUCCESS, PRIOR_FAILURE): trust = (s + a) / (s + f + a + b). A policy acts
on its own only while trust >= TRUST_FLOOR; below it, the same diagnosis is
escalated to an operator. Durable operator-approved fixes earn trust back.
"""

from __future__ import annotations

from . import config

VERSION = 1


def key(policy_id: str, service_id: str) -> str:
    return f"{policy_id}:{service_id}"


class TrustLedger:
    def __init__(self) -> None:
        self.records: dict[str, dict] = {}
        # Fixes awaiting their durability verdict.
        self.pending: list[dict] = []

    # ------------------------------------------------------------ model

    def _record(self, policy_id: str, service_id: str) -> dict:
        k = key(policy_id, service_id)
        if k not in self.records:
            self.records[k] = {
                "policyId": policy_id, "serviceId": service_id, "successes": 0, "failures": 0,
                "relapses": 0, "lastOutcome": None, "updatedAt": None,
            }
        return self.records[k]

    @staticmethod
    def score(rec: dict | None) -> float:
        s = rec["successes"] if rec else 0
        f = rec["failures"] if rec else 0
        a, b = config.TRUST_PRIOR_SUCCESS, config.TRUST_PRIOR_FAILURE
        return (s + a) / (s + f + a + b)

    def trust(self, policy_id: str, service_id: str) -> float:
        return self.score(self.records.get(key(policy_id, service_id)))

    def autonomous(self, policy_id: str, service_id: str) -> bool:
        return self.trust(policy_id, service_id) >= config.TRUST_FLOOR

    def record(self, policy_id: str, service_id: str) -> dict | None:
        return self.records.get(key(policy_id, service_id))

    # ----------------------------------------------------------- events

    def executed(self, policy_id: str, service_id: str, fault: str, incident_id: str | None, t: int) -> None:
        """A fix ran and passed verification; its durability is decided later."""
        self.pending = [p for p in self.pending if p["serviceId"] != service_id or p["fault"] != fault]
        self.pending.append({"policyId": policy_id, "serviceId": service_id, "fault": fault,
                             "incidentId": incident_id, "at": t})

    def failed(self, policy_id: str, service_id: str, t: int, outcome: str) -> None:
        rec = self._record(policy_id, service_id)
        rec["failures"] += 1
        rec["lastOutcome"] = outcome
        rec["updatedAt"] = t

    def relapse(self, service_id: str, fault: str, t: int) -> dict | None:
        """The same fault came back: the earlier fix was not durable."""
        window = config.RELAPSE_WINDOW_SEC * 1000
        hit = next((p for p in self.pending
                    if p["serviceId"] == service_id and p["fault"] == fault and t - p["at"] < window), None)
        if hit is None:
            return None
        self.pending.remove(hit)
        rec = self._record(hit["policyId"], service_id)
        rec["failures"] += 1
        rec["relapses"] += 1
        rec["lastOutcome"] = "relapsed"
        rec["updatedAt"] = t
        return hit

    def expire(self, t: int) -> bool:
        """Fixes that held for the whole window become durable successes."""
        window = config.RELAPSE_WINDOW_SEC * 1000
        done = [p for p in self.pending if t - p["at"] >= window]
        if not done:
            return False
        for p in done:
            self.pending.remove(p)
            rec = self._record(p["policyId"], p["serviceId"])
            rec["successes"] += 1
            rec["lastOutcome"] = "durable"
            rec["updatedAt"] = t
        return True

    def reset(self, policy_id: str | None = None, service_id: str | None = None) -> None:
        if policy_id is None:
            self.records.clear()
            self.pending.clear()
            return
        self.records.pop(key(policy_id, service_id or ""), None)
        self.pending = [p for p in self.pending
                        if not (p["policyId"] == policy_id and p["serviceId"] == service_id)]

    # ------------------------------------------------------ persistence

    def doc(self) -> list[dict]:
        out = []
        for rec in self.records.values():
            trust = self.score(rec)
            out.append({**rec, "trust": round(trust, 3), "autonomous": trust >= config.TRUST_FLOOR})
        for p in self.pending:
            if key(p["policyId"], p["serviceId"]) not in self.records:
                out.append({"policyId": p["policyId"], "serviceId": p["serviceId"], "successes": 0,
                            "failures": 0, "relapses": 0, "lastOutcome": None, "updatedAt": None,
                            "trust": round(self.score(None), 3), "autonomous": True})
        pending = {key(p["policyId"], p["serviceId"]): p["at"] for p in self.pending}
        for row in out:
            at = pending.get(key(row["policyId"], row["serviceId"]))
            row["pendingSince"] = at
        return sorted(out, key=lambda r: (r["policyId"], r["serviceId"]))

    def export(self) -> dict:
        return {"version": VERSION, "records": self.records, "pending": self.pending}

    def restore(self, saved: object) -> None:
        if not isinstance(saved, dict) or saved.get("version") != VERSION:
            return
        records = saved.get("records")
        pending = saved.get("pending")
        if isinstance(records, dict):
            self.records = {k: v for k, v in records.items() if isinstance(v, dict)}
        if isinstance(pending, list):
            self.pending = [p for p in pending if isinstance(p, dict)]
