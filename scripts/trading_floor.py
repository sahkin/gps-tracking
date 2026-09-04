#!/usr/bin/env python3
"""
TradingFloorSystem v2 -- multi-node token screening & staged execution engine.

Pipeline:  SEARCH -> RISK -> CONFIRM (whale/shill/liquidity/holders) -> SCORE -> SIZE -> STAGE -> APPROVE -> EXECUTE -> SENTINELS

Design rules (non-negotiable):
  * PAPER mode by default. LIVE execution requires an injected Broker adapter AND TF_MODE=live.
  * No private keys, seed phrases or secrets ever touch this process. Any attempt halts the floor.
  * Every order requires an exact, human-typed approval token: "APPROVE #<thread> <nonce>".
  * Hard circuit breakers: daily loss, max concurrent positions, per-trade risk cap, cooldown after loss streak.
  * Every decision is appended to an immutable JSONL audit log.

Configuration is read from environment variables (all optional):
  TF_MODE                paper | live            (default: paper)
  TF_BANKROLL            starting capital        (default: 10000)
  TF_MAX_DAILY_LOSS      fraction, e.g. 0.05     (default: 0.05)
  TF_MAX_POSITIONS       int                     (default: 3)
  TF_RISK_PER_TRADE      fraction, e.g. 0.01     (default: 0.01)
  TF_MIN_SCORE           0-100 conviction gate   (default: 70)
  TF_AUDIT_PATH          path to JSONL audit log (default: ./trading_floor_audit.jsonl)
  SCANNED                optional label appended to SEARCH events (already set in this project)
"""

from __future__ import annotations

import json
import logging
import os
import secrets
import sys
import time
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from enum import Enum, auto
from pathlib import Path
from typing import Callable, Dict, List, Optional, Protocol


# --------------------------------------------------------------------------- #
#  Logging
# --------------------------------------------------------------------------- #

class NodeFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        if not hasattr(record, "node"):
            record.node = "FLOOR"
        return super().format(record)


_handler = logging.StreamHandler(sys.stdout)
_handler.setFormatter(NodeFormatter("%(asctime)s [%(levelname)-8s] [%(node)-7s] %(message)s"))
log = logging.getLogger("trading_floor")
log.setLevel(logging.INFO)
log.addHandler(_handler)
log.propagate = False


def node_log(node: str, msg: str, level: int = logging.INFO) -> None:
    log.log(level, msg, extra={"node": node})


# --------------------------------------------------------------------------- #
#  Errors & enums
# --------------------------------------------------------------------------- #

class FloorHalted(RuntimeError):
    """Raised when a circuit breaker trips. The floor refuses all further work."""


class SecurityViolation(RuntimeError):
    """Raised when secret material is detected anywhere in the input stream."""


class Stage(Enum):
    SCANNED = auto()
    REJECTED = auto()
    CLEARED = auto()
    CONFIRMED = auto()
    STAGED = auto()
    EXECUTED = auto()
    CLOSED = auto()
    EXPIRED = auto()


class ExitReason(Enum):
    TAKE_PROFIT = auto()
    STOP_LOSS = auto()
    TRAILING_STOP = auto()
    RUG_DETECTED = auto()
    TIME_STOP = auto()
    MANUAL = auto()


# --------------------------------------------------------------------------- #
#  Domain models
# --------------------------------------------------------------------------- #

@dataclass(frozen=True)
class Lead:
    token: str
    symbol: str
    reason: str
    # On-chain security
    mint_revoked: bool
    freeze_revoked: bool
    lp_locked: bool
    lp_lock_days: int = 0
    honeypot: bool = False
    # Market structure
    liquidity_usd: float = 0.0
    market_cap_usd: float = 0.0
    top10_holder_pct: float = 100.0
    dev_wallet_pct: float = 100.0
    holders: int = 0
    age_minutes: int = 0
    # Signal nodes
    whale_score: float = 0.0        # 0-1 stealth accumulation confidence
    shill_organic_score: float = 0.0  # 0-1 organic social velocity confidence
    volume_5m_usd: float = 0.0
    buys_5m: int = 0
    sells_5m: int = 0
    price_usd: float = 0.0
    extra: Dict[str, object] = field(default_factory=dict)


@dataclass
class RiskVerdict:
    passed: bool
    reasons: List[str] = field(default_factory=list)
    warnings: List[str] = field(default_factory=list)


@dataclass
class Conviction:
    score: float                      # 0-100
    breakdown: Dict[str, float] = field(default_factory=dict)
    confirms: int = 0


@dataclass
class OrderPlan:
    size_usd: float
    entry_price: float
    stop_loss: float
    take_profit: float
    trailing_pct: float
    max_hold_minutes: int
    slippage_bps: int


@dataclass
class Thread:
    tid: int
    lead: Lead
    stage: Stage = Stage.SCANNED
    risk: Optional[RiskVerdict] = None
    conviction: Optional[Conviction] = None
    plan: Optional[OrderPlan] = None
    approval_nonce: Optional[str] = None
    staged_at: Optional[float] = None
    executed_at: Optional[float] = None
    fill_price: Optional[float] = None
    peak_price: Optional[float] = None
    realized_pnl_usd: float = 0.0
    exit_reason: Optional[ExitReason] = None
    events: List[str] = field(default_factory=list)

    def note(self, msg: str) -> None:
        self.events.append(f"{datetime.now(timezone.utc).isoformat()} {msg}")


# --------------------------------------------------------------------------- #
#  Config
# --------------------------------------------------------------------------- #

def _env_float(key: str, default: float) -> float:
    try:
        return float(os.environ.get(key, default))
    except ValueError:
        return default


def _env_int(key: str, default: int) -> int:
    try:
        return int(os.environ.get(key, default))
    except ValueError:
        return default


@dataclass
class FloorConfig:
    mode: str = os.environ.get("TF_MODE", "paper").lower()
    bankroll: float = _env_float("TF_BANKROLL", 10_000.0)
    max_daily_loss: float = _env_float("TF_MAX_DAILY_LOSS", 0.05)
    max_positions: int = _env_int("TF_MAX_POSITIONS", 3)
    risk_per_trade: float = _env_float("TF_RISK_PER_TRADE", 0.01)
    min_score: float = _env_float("TF_MIN_SCORE", 70.0)
    loss_streak_cooldown: int = 3            # consecutive losses before mandatory cooldown
    cooldown_seconds: int = 900
    staging_ttl_seconds: int = 300           # staged orders expire if not approved
    audit_path: Path = Path(os.environ.get("TF_AUDIT_PATH", "trading_floor_audit.jsonl"))
    scanned_label: str = os.environ.get("SCANNED", "")

    # Risk thresholds
    min_liquidity_usd: float = 25_000.0
    min_lp_lock_days: int = 30
    max_top10_pct: float = 35.0
    max_dev_pct: float = 5.0
    min_holders: int = 150
    min_age_minutes: int = 10

    # Exit defaults
    default_stop_pct: float = 0.20
    default_tp_pct: float = 0.60
    default_trailing_pct: float = 0.15
    default_max_hold_minutes: int = 240
    default_slippage_bps: int = 150


# --------------------------------------------------------------------------- #
#  Security guard
# --------------------------------------------------------------------------- #

FORBIDDEN_TERMS = (
    "private key", "privatekey", "seed phrase", "mnemonic", "secret key",
    "secretkey", "keypair", "wallet.json", "id.json", "-----begin",
)


def security_scan(*texts: str) -> None:
    for text in texts:
        low = (text or "").lower()
        if any(term in low for term in FORBIDDEN_TERMS):
            raise SecurityViolation("SECURITY VIOLATION: secret material detected in input. Floor terminated.")
        # Base58 blobs of Solana-secret length are also a red flag.
        for tok in low.replace(",", " ").split():
            if 80 <= len(tok) <= 90 and tok.isalnum():
                raise SecurityViolation("SECURITY VIOLATION: key-shaped token detected. Floor terminated.")


# --------------------------------------------------------------------------- #
#  Audit log
# --------------------------------------------------------------------------- #

class AuditLog:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)

    def write(self, event: str, tid: Optional[int], **payload: object) -> None:
        record = {
            "ts": datetime.now(timezone.utc).isoformat(),
            "event": event,
            "thread": tid,
            **payload,
        }
        with self.path.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(record, default=str) + "\n")


# --------------------------------------------------------------------------- #
#  Pluggable risk rules
# --------------------------------------------------------------------------- #

RiskRule = Callable[[Lead, FloorConfig], Optional[str]]


def rule_mint(lead: Lead, _: FloorConfig) -> Optional[str]:
    return None if lead.mint_revoked else "Mint authority still active"


def rule_freeze(lead: Lead, _: FloorConfig) -> Optional[str]:
    return None if lead.freeze_revoked else "Freeze authority still active"


def rule_honeypot(lead: Lead, _: FloorConfig) -> Optional[str]:
    return "Honeypot / sell-tax trap detected" if lead.honeypot else None


def rule_lp(lead: Lead, cfg: FloorConfig) -> Optional[str]:
    if not lead.lp_locked:
        return "LP unlocked"
    if lead.lp_lock_days < cfg.min_lp_lock_days:
        return f"LP lock too short ({lead.lp_lock_days}d < {cfg.min_lp_lock_days}d)"
    return None


def rule_liquidity(lead: Lead, cfg: FloorConfig) -> Optional[str]:
    if lead.liquidity_usd < cfg.min_liquidity_usd:
        return f"Thin liquidity (${lead.liquidity_usd:,.0f} < ${cfg.min_liquidity_usd:,.0f})"
    return None


def rule_concentration(lead: Lead, cfg: FloorConfig) -> Optional[str]:
    if lead.top10_holder_pct > cfg.max_top10_pct:
        return f"Top-10 holders own {lead.top10_holder_pct:.1f}% (> {cfg.max_top10_pct}%)"
    if lead.dev_wallet_pct > cfg.max_dev_pct:
        return f"Dev wallet holds {lead.dev_wallet_pct:.1f}% (> {cfg.max_dev_pct}%)"
    return None


def rule_holders(lead: Lead, cfg: FloorConfig) -> Optional[str]:
    if lead.holders < cfg.min_holders:
        return f"Too few holders ({lead.holders} < {cfg.min_holders})"
    return None


def rule_age(lead: Lead, cfg: FloorConfig) -> Optional[str]:
    if lead.age_minutes < cfg.min_age_minutes:
        return f"Contract too fresh ({lead.age_minutes}m < {cfg.min_age_minutes}m)"
    return None


HARD_RULES: List[RiskRule] = [rule_mint, rule_freeze, rule_honeypot, rule_lp, rule_liquidity]
SOFT_RULES: List[RiskRule] = [rule_concentration, rule_holders, rule_age]


# --------------------------------------------------------------------------- #
#  Broker adapter (paper by default)
# --------------------------------------------------------------------------- #

class Broker(Protocol):
    def buy(self, token: str, size_usd: float, max_slippage_bps: int) -> float: ...
    def sell(self, token: str, size_usd: float, max_slippage_bps: int) -> float: ...


class PaperBroker:
    """Simulates fills with a tiny random slippage. Never touches a chain."""

    def buy(self, token: str, size_usd: float, max_slippage_bps: int) -> float:
        return 1.0 + (secrets.randbelow(max_slippage_bps) / 10_000)

    def sell(self, token: str, size_usd: float, max_slippage_bps: int) -> float:
        return 1.0 - (secrets.randbelow(max_slippage_bps) / 10_000)


# --------------------------------------------------------------------------- #
#  The floor
# --------------------------------------------------------------------------- #

class TradingFloorSystem:
    def __init__(self, cfg: Optional[FloorConfig] = None, broker: Optional[Broker] = None) -> None:
        self.cfg = cfg or FloorConfig()
        self.broker: Broker = broker or PaperBroker()
        self.audit = AuditLog(self.cfg.audit_path)

        if self.cfg.mode == "live" and isinstance(self.broker, PaperBroker):
            raise FloorHalted("TF_MODE=live requires an injected Broker adapter. Refusing to start.")

        self.equity = self.cfg.bankroll
        self.day_start_equity = self.cfg.bankroll
        self.is_halted = False
        self.loss_streak = 0
        self.cooldown_until = 0.0
        self._tid = 100
        self.threads: Dict[int, Thread] = {}

        node_log("FLOOR", f"Floor online | mode={self.cfg.mode.upper()} | bankroll=${self.equity:,.2f} | "
                          f"daily-loss-halt={self.cfg.max_daily_loss:.0%} | max-pos={self.cfg.max_positions}")
        self.audit.write("floor_online", None, config={k: str(v) for k, v in asdict(self.cfg).items()})

    # ---- circuit breakers ------------------------------------------------- #

    @property
    def daily_drawdown(self) -> float:
        return max(0.0, (self.day_start_equity - self.equity) / self.day_start_equity)

    @property
    def open_positions(self) -> List[Thread]:
        return [t for t in self.threads.values() if t.stage is Stage.EXECUTED]

    def guard(self, *texts: str) -> None:
        security_scan(*texts)
        if self.is_halted:
            raise FloorHalted("Floor is halted.")
        if self.daily_drawdown >= self.cfg.max_daily_loss:
            self.is_halted = True
            self.audit.write("halt", None, reason="daily_loss", drawdown=self.daily_drawdown)
            raise FloorHalted(f"CRITICAL: {self.daily_drawdown:.2%} daily drawdown >= {self.cfg.max_daily_loss:.0%}. Floor halted.")
        if time.time() < self.cooldown_until:
            remaining = int(self.cooldown_until - time.time())
            raise FloorHalted(f"Cooldown active after {self.loss_streak} consecutive losses ({remaining}s remaining).")

    # ---- pipeline --------------------------------------------------------- #

    def process_lead(self, lead: Lead) -> Thread:
        self.guard(lead.token, lead.symbol, lead.reason)
        self._tid += 1
        th = Thread(tid=self._tid, lead=lead)
        self.threads[th.tid] = th
        self._expire_stale()

        label = f" [{self.cfg.scanned_label}]" if self.cfg.scanned_label else ""
        node_log("SEARCH", f"[#{th.tid}] {lead.symbol} ({lead.token}){label} :: {lead.reason}")
        self.audit.write("scanned", th.tid, lead=asdict(lead))

        # RISK
        th.risk = self._risk_audit(lead)
        if not th.risk.passed:
            th.stage = Stage.REJECTED
            node_log("RISK", f"[#{th.tid}] REJECT :: {'; '.join(th.risk.reasons)}", logging.WARNING)
            self.audit.write("risk_reject", th.tid, reasons=th.risk.reasons)
            return th
        th.stage = Stage.CLEARED
        node_log("RISK", f"[#{th.tid}] CLEAR" + (f" (warnings: {'; '.join(th.risk.warnings)})" if th.risk.warnings else ""))

        # CONFIRM + SCORE
        th.conviction = self._score(lead, th.risk)
        for k, v in th.conviction.breakdown.items():
            node_log(k.upper()[:7], f"[#{th.tid}] {k}: {v:+.1f}")
        node_log("SCORE", f"[#{th.tid}] conviction={th.conviction.score:.1f}/100 confirms={th.conviction.confirms}/2")
        self.audit.write("scored", th.tid, score=th.conviction.score, breakdown=th.conviction.breakdown)

        if th.conviction.confirms < 2 or th.conviction.score < self.cfg.min_score:
            node_log("FLOOR", f"[#{th.tid}] HOLD :: needs 2 confirms and score >= {self.cfg.min_score:.0f}")
            return th
        th.stage = Stage.CONFIRMED

        # CAPACITY
        if len(self.open_positions) >= self.cfg.max_positions:
            node_log("FLOOR", f"[#{th.tid}] HOLD :: max positions ({self.cfg.max_positions}) reached", logging.WARNING)
            return th

        # SIZE + STAGE
        th.plan = self._size(lead, th.conviction)
        th.approval_nonce = secrets.token_hex(3).upper()
        th.staged_at = time.time()
        th.stage = Stage.STAGED
        node_log("SNIPER", f"[#{th.tid}] STAGED ${th.plan.size_usd:,.2f} @ {th.plan.entry_price:.8f} | "
                           f"SL {th.plan.stop_loss:.8f} | TP {th.plan.take_profit:.8f} | trail {th.plan.trailing_pct:.0%}")
        node_log("SNIPER", f"[#{th.tid}] Awaiting exact command:  APPROVE #{th.tid} {th.approval_nonce}   "
                           f"(expires in {self.cfg.staging_ttl_seconds}s)")
        self.audit.write("staged", th.tid, plan=asdict(th.plan))
        return th

    def _risk_audit(self, lead: Lead) -> RiskVerdict:
        verdict = RiskVerdict(passed=True)
        for rule in HARD_RULES:
            if (msg := rule(lead, self.cfg)):
                verdict.passed = False
                verdict.reasons.append(msg)
        for rule in SOFT_RULES:
            if (msg := rule(lead, self.cfg)):
                verdict.warnings.append(msg)
        return verdict

    def _score(self, lead: Lead, risk: RiskVerdict) -> Conviction:
        b: Dict[str, float] = {}
        confirms = 0

        # Whale node (0-30)
        b["whale"] = round(lead.whale_score * 30, 1)
        if lead.whale_score >= 0.6:
            confirms += 1
            node_log("WHALE", f"Stealth accumulation confidence {lead.whale_score:.0%}")

        # Shill node (0-20)
        b["shill"] = round(lead.shill_organic_score * 20, 1)
        if lead.shill_organic_score >= 0.6:
            confirms += 1
            node_log("SHILL", f"Organic velocity confidence {lead.shill_organic_score:.0%}")

        # Order-flow node (0-20): buy pressure
        total = lead.buys_5m + lead.sells_5m
        buy_ratio = lead.buys_5m / total if total else 0.5
        b["flow"] = round((buy_ratio - 0.5) * 40, 1)  # -20..+20

        # Liquidity depth vs mcap (0-15): healthy = 10-30%
        if lead.market_cap_usd > 0:
            ratio = lead.liquidity_usd / lead.market_cap_usd
            b["liquidity"] = round(15 * min(1.0, ratio / 0.15), 1)
        else:
            b["liquidity"] = 0.0

        # Distribution (0-15)
        dist = max(0.0, 1 - (lead.top10_holder_pct / 100)) * 0.6 + max(0.0, 1 - lead.dev_wallet_pct / 20) * 0.4
        b["distribution"] = round(dist * 15, 1)

        # Soft-rule penalties
        b["penalties"] = round(-7.5 * len(risk.warnings), 1)

        score = max(0.0, min(100.0, sum(b.values())))
        return Conviction(score=round(score, 1), breakdown=b, confirms=confirms)

    def _size(self, lead: Lead, conv: Conviction) -> OrderPlan:
        # Risk-based sizing: risk_per_trade of equity is lost if the stop is hit.
        stop_pct = self.cfg.default_stop_pct
        risk_budget = self.equity * self.cfg.risk_per_trade
        raw_size = risk_budget / stop_pct
        # Scale by conviction (0.5x at min_score .. 1.0x at 100)
        conv_mult = 0.5 + 0.5 * (conv.score - self.cfg.min_score) / max(1.0, 100 - self.cfg.min_score)
        # Never exceed 2% of pool liquidity to keep price impact sane.
        liq_cap = lead.liquidity_usd * 0.02
        size = min(raw_size * conv_mult, liq_cap, self.equity * 0.10)
        price = lead.price_usd or 1.0
        return OrderPlan(
            size_usd=round(size, 2),
            entry_price=price,
            stop_loss=price * (1 - stop_pct),
            take_profit=price * (1 + self.cfg.default_tp_pct),
            trailing_pct=self.cfg.default_trailing_pct,
            max_hold_minutes=self.cfg.default_max_hold_minutes,
            slippage_bps=self.cfg.default_slippage_bps,
        )

    def _expire_stale(self) -> None:
        now = time.time()
        for th in self.threads.values():
            if th.stage is Stage.STAGED and th.staged_at and now - th.staged_at > self.cfg.staging_ttl_seconds:
                th.stage = Stage.EXPIRED
                node_log("SNIPER", f"[#{th.tid}] staged order expired unapproved", logging.WARNING)
                self.audit.write("expired", th.tid)

    # ---- execution -------------------------------------------------------- #

    def execute(self, tid: int, approval_command: str) -> bool:
        self.guard(approval_command)
        th = self.threads.get(tid)
        if not th or th.stage is not Stage.STAGED:
            node_log("SNIPER", f"[#{tid}] STOP :: no staged order for this thread", logging.ERROR)
            return False

        expected = f"APPROVE #{tid} {th.approval_nonce}"
        if approval_command.strip() != expected:
            node_log("SNIPER", f"[#{tid}] STOP :: invalid approval. Exact '{expected}' required.", logging.ERROR)
            self.audit.write("approval_rejected", tid, given=approval_command)
            return False

        assert th.plan is not None
        fill_mult = self.broker.buy(th.lead.token, th.plan.size_usd, th.plan.slippage_bps)
        th.fill_price = th.plan.entry_price * fill_mult
        th.peak_price = th.fill_price
        th.executed_at = time.time()
        th.stage = Stage.EXECUTED
        node_log("SNIPER", f"[#{tid}] EXECUTED ({self.cfg.mode.upper()}) ${th.plan.size_usd:,.2f} @ {th.fill_price:.8f} "
                           f"(slip {(fill_mult - 1) * 1e4:.0f}bps). Handed to EXIT + RUG sentinels.")
        self.audit.write("executed", tid, fill=th.fill_price, size=th.plan.size_usd, mode=self.cfg.mode)
        return True

    # ---- sentinels -------------------------------------------------------- #

    def tick(self, tid: int, price: float, *, lp_pulled: bool = False, dev_dumped: bool = False) -> Optional[ExitReason]:
        """Feed a price/on-chain tick to an open position. Returns an ExitReason if the position was closed."""
        th = self.threads.get(tid)
        if not th or th.stage is not Stage.EXECUTED or th.plan is None or th.fill_price is None:
            return None

        th.peak_price = max(th.peak_price or price, price)
        held_min = (time.time() - (th.executed_at or time.time())) / 60

        reason: Optional[ExitReason] = None
        if lp_pulled or dev_dumped:
            reason = ExitReason.RUG_DETECTED
        elif price <= th.plan.stop_loss:
            reason = ExitReason.STOP_LOSS
        elif price >= th.plan.take_profit:
            reason = ExitReason.TAKE_PROFIT
        elif th.peak_price > th.fill_price * 1.10 and price <= th.peak_price * (1 - th.plan.trailing_pct):
            reason = ExitReason.TRAILING_STOP
        elif held_min >= th.plan.max_hold_minutes:
            reason = ExitReason.TIME_STOP

        if reason:
            self._close(th, price, reason)
        return reason

    def close_manual(self, tid: int, price: float) -> None:
        th = self.threads.get(tid)
        if th and th.stage is Stage.EXECUTED:
            self._close(th, price, ExitReason.MANUAL)

    def _close(self, th: Thread, price: float, reason: ExitReason) -> None:
        assert th.plan and th.fill_price
        # Rug exits get punished with worst-case slippage.
        slip_bps = th.plan.slippage_bps * (4 if reason is ExitReason.RUG_DETECTED else 1)
        exit_price = price * self.broker.sell(th.lead.token, th.plan.size_usd, slip_bps)
        pnl = th.plan.size_usd * (exit_price / th.fill_price - 1)
        th.realized_pnl_usd = round(pnl, 2)
        th.exit_reason = reason
        th.stage = Stage.CLOSED
        self.equity += pnl

        if pnl < 0:
            self.loss_streak += 1
            if self.loss_streak >= self.cfg.loss_streak_cooldown:
                self.cooldown_until = time.time() + self.cfg.cooldown_seconds
                node_log("FLOOR", f"{self.loss_streak} consecutive losses -> cooldown {self.cfg.cooldown_seconds}s", logging.WARNING)
        else:
            self.loss_streak = 0

        node = "RUG" if reason is ExitReason.RUG_DETECTED else "EXIT"
        node_log(node, f"[#{th.tid}] CLOSED {reason.name} @ {exit_price:.8f} | PnL {pnl:+,.2f} | "
                       f"equity ${self.equity:,.2f} | DD {self.daily_drawdown:.2%}")
        self.audit.write("closed", th.tid, reason=reason.name, exit=exit_price, pnl=pnl, equity=self.equity)

    # ---- reporting -------------------------------------------------------- #

    def report(self) -> Dict[str, object]:
        closed = [t for t in self.threads.values() if t.stage is Stage.CLOSED]
        wins = [t for t in closed if t.realized_pnl_usd > 0]
        return {
            "mode": self.cfg.mode,
            "equity": round(self.equity, 2),
            "pnl": round(self.equity - self.cfg.bankroll, 2),
            "drawdown": f"{self.daily_drawdown:.2%}",
            "open": len(self.open_positions),
            "closed": len(closed),
            "win_rate": f"{(len(wins) / len(closed)):.0%}" if closed else "n/a",
            "halted": self.is_halted,
            "stages": {s.name: sum(1 for t in self.threads.values() if t.stage is s) for s in Stage},
        }


# --------------------------------------------------------------------------- #
#  Demo
# --------------------------------------------------------------------------- #

if __name__ == "__main__":
    floor = TradingFloorSystem()

    strong = Lead(
        token="So11...PUMP", symbol="PUMP", reason="Fresh LP + dev deploy + wallet cluster accumulating",
        mint_revoked=True, freeze_revoked=True, lp_locked=True, lp_lock_days=180, honeypot=False,
        liquidity_usd=140_000, market_cap_usd=900_000, top10_holder_pct=22, dev_wallet_pct=2.5,
        holders=1_240, age_minutes=45, whale_score=0.82, shill_organic_score=0.71,
        volume_5m_usd=38_000, buys_5m=212, sells_5m=96, price_usd=0.00091,
    )
    trap = Lead(
        token="So11...RUGG", symbol="RUGG", reason="Trending on socials",
        mint_revoked=False, freeze_revoked=True, lp_locked=True, lp_lock_days=3,
        liquidity_usd=9_000, market_cap_usd=2_000_000, top10_holder_pct=71, dev_wallet_pct=18,
        holders=60, age_minutes=4, whale_score=0.2, shill_organic_score=0.9,
        buys_5m=40, sells_5m=5, price_usd=0.002,
    )

    floor.process_lead(trap)
    th = floor.process_lead(strong)

    if th.stage is Stage.STAGED:
        # A wrong command is rejected...
        floor.execute(th.tid, f"APPROVE #{th.tid}")
        # ...only the exact human-typed token (with nonce) executes.
        floor.execute(th.tid, f"APPROVE #{th.tid} {th.approval_nonce}")

        # Sentinel ticks: rally, then trailing stop triggers.
        for px in (0.00095, 0.00105, 0.00121, 0.00118, 0.00101):
            if floor.tick(th.tid, px):
                break

    print(json.dumps(floor.report(), indent=2))
