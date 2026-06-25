"""API-owned long-lived service objects."""

from ..trading.lean_lanes import LeanLaneManager
from ..whitepapers import WhitepaperWorkflowService

LEAN_LANE_MANAGER = LeanLaneManager()
WHITEPAPER_WORKFLOW = WhitepaperWorkflowService()

__all__ = ("LEAN_LANE_MANAGER", "WHITEPAPER_WORKFLOW")
