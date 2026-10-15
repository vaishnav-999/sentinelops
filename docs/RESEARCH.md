# SentinelOps — research guide

How to turn the system into a paper: research questions, how the method maps to
the literature, the exact experiment protocol, how to report results honestly,
and verified references. Every number in the paper must come from
`scripts/evaluate.py` output, never typed by hand.

## 1. Positioning

Working title: *SentinelOps: A Hybrid Isolation-Forest and Rule-Based
Self-Healing Loop for Containerised Microservices with Safe Escalation*

The gap this work fills (cite [3], [4], [8]):

- Most anomaly-detection and RCA research stops at detection or localisation
  and is evaluated offline on recorded datasets [4], [5], [6].
- Self-healing systems that close the loop (detect → diagnose → act → verify)
  are usually evaluated with few trials and without a fault-free period, so
  false positives are not measured [8].
- LLM-based systems increasingly decide remediation themselves [9], [11]. This
  system keeps decisions deterministic and auditable, and uses the LLM only for
  the post-incident narrative [10].

Contributions to claim (only what the code does):

1. A closed MAPE-K loop [2] on real Docker containers: 1 Hz telemetry, per-service
   Isolation Forest + static threshold rules, signature-based diagnosis,
   policy-gated remediation with guardrails, post-action health verification.
2. Detector changes for operational telemetry (Section 3), each motivated by a
   false-positive mode observed in the soak tests.
3. Correlation safeguards: dependency attribution and a host-wide guard so one
   fault does not cause several restarts.
4. A reproducible evaluation harness: fault injection campaign + fault-free soak,
   per-detector rates with 95% Wilson intervals [13], diagnosis confusion matrix,
   time-to-detect and time-to-recover distributions, rule-only baseline.
5. Safe escalation: unknown anomalies and guardrail hits go to an operator
   instead of an automated action.

## 2. Research questions

| RQ | Question | Measured by |
|---|---|---|
| RQ1 | Does the hybrid detector find more faults, sooner, than static thresholds alone? | Detection rate and time-to-detect per fault type and detector |
| RQ2 | How often does it raise an alarm when nothing is wrong? | False-positive service-minutes during the soak; precision, specificity, balanced accuracy |
| RQ3 | How accurately does signature matching identify the injected fault? | Diagnosis accuracy, confusion matrix |
| RQ4 | Does the closed loop recover services, and how fast? | Correct handling rate; detect→resolved and inject→resolved times; hybrid vs threshold-only campaign |
| RQ5 (optional) | Are the Gemini reports faithful and useful? | Human rating study (Section 6) |

## 3. Method (what the code actually does)

Map each item to MAPE-K [2] in the paper's architecture figure.

**Monitor** — `backend/app/core.py`, `docker_io.py`, `probes.py`
- Every second: Docker stats (CPU, memory % of limit), HTTP probes (p95
  latency, error rate, throughput), Redis INFO (memory, hit rate).
- Stall guard: a gap > 5 s between samples (host paused) holds detection for 30 s.

**Analyze, detection** — `backend/app/detector.py`
- Features per service: CPU, memory, memory slope (%/10 s), p95, error rate,
  throughput.
- Isolation Forest [1] trained per service on 240+ healthy samples, retrained
  every 300 samples, baselines persisted across restarts.
- Changes vs standard iForest (state these as design choices, then test them
  with an ablation if time allows):
  - *Range-aware path length*: a point outside a node's training range is
    isolated with probability d/(range+d), so scores keep rising for values far
    outside the training data instead of saturating. Contrast with the
    axis-parallel bias discussed in Extended Isolation Forest [12].
  - *One-sided degradation features*: only "worse" directions count (CPU,
    memory, latency, errors up; throughput down).
  - *Effect-size gate*: an alarm needs score ≥ 0.6 and at least a 4σ deviation
    that is also an operationally meaningful absolute change, for 5 consecutive
    samples.
- Static threshold rule: CPU > 85%, memory > 90%, p95 > 500 ms or error rate
  > 5%, held for 3 samples. This is the rule-based baseline.

**Analyze, diagnosis** — `backend/app/diagnoser.py`
- Fault signatures (crash, memory leak, CPU saturation, latency, cache
  saturation) scored 0–1 as a "signature match". Below 0.70 the result is
  UNKNOWN. The Isolation Forest only produces an anomaly score; it does not name
  the fault.

**Plan** — `catalog.py` policies + guardrails in `core.py`
- One policy per signature, with risk level and mode. Guardrails: at most 2
  automatic actions per service per 30 min, plus a cooldown. Restricted or
  unknown cases escalate.
- Correlation: degradation explained by a dependency that is down, being
  remediated or just restarted is attributed, not remediated. When three or more
  independent services degrade together, remediation is held (host-wide cause).

**Execute + verify**
- Restart container/worker, clear cache, scale out a replica. Then 3 health
  checks must pass before the incident is resolved.

**Knowledge** — Postgres: incidents, executions, experiments, detections,
baselines, audit log.

**Explain** — `src/app/api/ai/incident-report/route.ts`
- Gemini writes a post-incident narrative from the recorded incident only, with
  a deterministic fallback. It never decides or executes anything (contrast
  [9], [10], [11]).

## 4. Experiment protocol

Run on one machine with nothing else heavy running. Record CPU, RAM, OS and the
Docker version for the paper.

1. Start the stack and wait for training (ML insights shows "Trained"):
   `docker compose -f docker-compose.live.yml up -d --build`
2. **Main campaign (hybrid).** 10 trials per scenario (60 trials), then a
   60-minute fault-free soak. About 2.5 hours.
   `python scripts/evaluate.py --trials 10 --soak-min 60`
3. **Baseline campaign (threshold-only).** Same settings with the Isolation
   Forest disabled. This gives the rule-based MTTD/MTTR baseline that the
   "improvement" figures compare against.
   `python scripts/evaluate.py --trials 10 --soak-min 60 --config threshold-only`
4. Optional repeat on the EC2 server (different hardware = external validity):
   `python scripts/evaluate.py --base https://<ip> --user admin --password ... --insecure --trials 10 --soak-min 60`
5. Keep each `research/<timestamp>_<config>/` folder. `runs.csv` and
   `traces.csv` are the dataset; `summary.md` has the tables.
6. To recompute after changing the analysis: `python scripts/evaluate.py --analyze research/<folder>`

Protocol details to state in the paper:
- Trials are interleaved (one of each scenario per round), not blocked, so
  drift affects all fault types equally.
- The environment is reset before every trial (faults reverted, replicas
  removed, guardrail counters cleared), then the runner waits for every
  detector to be quiet.
- Positives = injected trials. Negatives = fault-free service-minutes during the
  soak (6 services × minutes). A window counts as a false positive if the
  detector fired on that service in that minute. This window-based confusion
  matrix follows [8].
- Time-to-detect is measured from injection; time-to-recover is reported both
  from detection (MTTR) and from injection.
- Proportions are reported with 95% Wilson score intervals [13]. With 10 trials
  per fault, intervals are wide; say so.

## 5. Reporting rules

- Copy numbers from `summary.md` only. The app's ML insights page shows "—"
  until enough runs exist; do not fill it in by hand.
- **MTTD/MTTR improvement** is *hybrid vs threshold-only*, from the two
  campaigns. There is no measured human baseline, so do not claim an
  improvement over manual operations.
- Do not put your numbers in the same table as other papers' numbers as if
  they were comparable. The systems, fault sets and hardware differ. A
  qualitative comparison table (loop closed? FP measured? LLM decides?) is
  fine.
- Report failures and escalations; they show the guardrails working.

## 6. Optional: report quality (RQ5)

Following the human-evaluation approach in [10]: pick ~20 incidents, generate
the Gemini and the deterministic report for each, and have 3 raters score
faithfulness (no invented facts) and usefulness on a 1–5 scale, blind to the
source. Report the mean, and inter-rater agreement if you can.

## 7. Threats to validity (write these yourself)

- **Internal:** the fault signatures were designed alongside the injected faults,
  so diagnosis accuracy is optimistic for these fault types. The unknown-anomaly
  scenario and the soak are the checks against overfitting.
- **Construct:** time-to-detect depends on the 1 Hz sampling and the
  consecutive-sample requirements; state both.
- **External:** one synthetic 6-service application on a single Docker host;
  real systems have more services, traffic patterns and fault types [6].
  Recent work shows simple benchmarks overstate method quality [6].
- **Conclusion:** small n per fault type; use the confidence intervals.

## 8. Paper outline (IEEE conference, 6–8 pages)

1. Abstract — problem, approach, evaluation setup, headline results with n.
2. Introduction — why closed-loop self-healing; gap; contributions list.
3. Related work — anomaly detection and RCA [1], [4]–[7], [12]; self-healing
   and MAPE-K [2], [8], [11]; chaos engineering [3]; LLMs for incidents [9], [10].
4. System design — MAPE-K architecture figure; each stage from Section 3.
5. Detector design — iForest changes and why; the false-positive safeguards.
6. Evaluation — setup (hardware, services, faults table), protocol, RQ1–RQ4
   results tables and one time-series figure from `traces.csv`.
7. Discussion — what the threshold rule misses (memory leak), where escalation
   helped, limitations (Section 7).
8. Conclusion and future work — multi-host, Kubernetes, more fault types,
   public benchmark (e.g. RCAEval [5]).

## 9. References (verified)

[1] F. T. Liu, K. M. Ting, and Z.-H. Zhou, "Isolation Forest," in *Proc. IEEE ICDM*, 2008, pp. 413–422, doi: 10.1109/ICDM.2008.17.

[2] J. O. Kephart and D. M. Chess, "The vision of autonomic computing," *Computer*, vol. 36, no. 1, pp. 41–50, 2003, doi: 10.1109/MC.2003.1160055.

[3] A. Basiri *et al.*, "Chaos Engineering," *IEEE Software*, vol. 33, no. 3, pp. 35–41, 2016, doi: 10.1109/MS.2016.60.

[4] J. Soldani and A. Brogi, "Anomaly detection and failure root cause analysis in (micro)service-based cloud applications: A survey," *ACM Computing Surveys*, vol. 55, no. 3, 2022, doi: 10.1145/3501297.

[5] L. Pham, H. Zhang, *et al.*, "RCAEval: A benchmark for root cause analysis of microservice systems with telemetry data," in *Companion Proc. ACM Web Conference (WWW '25)*, 2025, doi: 10.1145/3701716.3715290.

[6] A. Fang *et al.*, "Rethinking the evaluation of microservice RCA with a fault propagation-aware benchmark," *Proc. ACM on Software Engineering*, 2026, doi: 10.1145/3797100 (arXiv:2510.04711).

[7] C. Lee, T. Yang, Z. Chen, Y. Su, and M. R. Lyu, "Eadro: An end-to-end troubleshooting framework for microservices on multi-source data," in *Proc. ICSE*, 2023 (arXiv:2302.05092).

[8] B. Magableh and M. Almiani, "A self healing microservices architecture: A case study in Docker Swarm cluster," in *Advanced Information Networking and Applications (AINA 2019)*, AISC vol. 926, Springer, 2020.

[9] Y. Chen *et al.*, "Automatic root cause analysis via large language models for cloud incidents," in *Proc. EuroSys*, 2024, doi: 10.1145/3627703.3629553.

[10] T. Ahmed, S. Ghosh, C. Bansal, T. Zimmermann, X. Zhang, and S. Rajmohan, "Recommending root-cause and mitigation steps for cloud incidents using large language models," in *Proc. ICSE*, 2023, doi: 10.1109/ICSE48619.2023.00149.

[11] Y. Wiesinger, M. Engelhardt, and R. Laas, "Leveraging low-parameter LLMs for self-healing in Kubernetes-based container orchestration," ACM, 2026, doi: 10.1145/3788550.3794882.

[12] S. Hariri, M. Carrasco Kind, and R. J. Brunner, "Extended Isolation Forest," *IEEE Trans. Knowledge and Data Engineering*, vol. 33, no. 4, pp. 1479–1489, 2021, doi: 10.1109/TKDE.2019.2947676.

[13] E. B. Wilson, "Probable inference, the law of succession, and statistical inference," *J. American Statistical Association*, vol. 22, no. 158, pp. 209–212, 1927.

Check each entry against the publisher page before submission (page numbers and
volume for [6] and [11] were not confirmed).
