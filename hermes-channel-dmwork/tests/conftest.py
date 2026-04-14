"""
Shared pytest configuration and fixtures.
"""

import pytest


@pytest.fixture
def sample_message_payload():
    """A sample text message payload dict."""
    return {
        "type": 1,
        "content": "Hello, world!",
    }


@pytest.fixture
def sample_mention_payload():
    """A sample message payload with mentions."""
    return {
        "type": 1,
        "content": "@Alice @Bob hello everyone",
        "mention": {
            "uids": ["uid1", "uid2"],
            "entities": [
                {"uid": "uid1", "offset": 0, "length": 6},
                {"uid": "uid2", "offset": 7, "length": 4},
            ],
        },
    }


@pytest.fixture
def sample_reply_payload():
    """A sample message payload with reply context."""
    return {
        "type": 1,
        "content": "This is a reply",
        "reply": {
            "from_uid": "user_original",
            "from_name": "OriginalSender",
            "payload": {
                "content": "Original message text",
            },
        },
    }
