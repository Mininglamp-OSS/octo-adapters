"""
DMWork (WuKongIM) platform adapter for Hermes Agent.

Provides a BasePlatformAdapter subclass that connects to DMWork's
WuKongIM-based messaging infrastructure via WebSocket binary protocol,
enabling bot-to-user and bot-to-group messaging.
"""

from hermes_dmwork.adapter import DMWorkAdapter
from hermes_dmwork.types import ChannelType, MessageType

__all__ = ["DMWorkAdapter", "ChannelType", "MessageType"]
__version__ = "0.2.0"
