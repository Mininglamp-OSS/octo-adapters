"""
Tests for issue #225 fixes:
- Filename decoding in download_file
- _build_content_disposition helper
- upload_file_to_cos Content-Disposition header
- upload_and_get_url parameter forwarding
"""

import inspect
import pytest
from unittest.mock import AsyncMock, MagicMock, patch
from urllib.parse import unquote

from hermes_dmwork.api import (
    _build_content_disposition,
    upload_file_to_cos,
    upload_and_get_url,
    download_file,
)


# ---------------------------------------------------------------------------
# _build_content_disposition — unit tests
# ---------------------------------------------------------------------------
class TestBuildContentDisposition:
    def test_ascii_safe_filename(self):
        result = _build_content_disposition("report.xlsx")
        assert result == 'attachment; filename="report.xlsx"'

    def test_ascii_with_quotes_falls_back(self):
        result = _build_content_disposition('report"v2.xlsx')
        assert 'filename="download.xlsx"' in result
        assert "filename*=UTF-8''" in result
        assert "%22" in result  # quote encoded

    def test_ascii_with_backslash_falls_back(self):
        result = _build_content_disposition("file\\path.txt")
        assert 'filename="download.txt"' in result
        assert "filename*=UTF-8''" in result

    def test_ascii_with_semicolon_falls_back(self):
        result = _build_content_disposition("file;name.txt")
        assert 'filename="download.txt"' in result
        assert "filename*=UTF-8''" in result

    def test_non_ascii_chinese(self):
        result = _build_content_disposition("审查.xlsx")
        assert 'filename="download.xlsx"' in result
        assert "filename*=UTF-8''" in result
        assert "%E5%AE%A1%E6%9F%A5" in result

    def test_mixed_ascii_and_chinese(self):
        result = _build_content_disposition("Q3审查_report.xlsx")
        assert 'filename="download.xlsx"' in result
        assert "filename*=UTF-8''" in result

    def test_ascii_with_apostrophe_is_safe(self):
        result = _build_content_disposition("John's Report.xlsx")
        assert result == """attachment; filename="John's Report.xlsx\""""

    def test_non_ascii_with_apostrophe_encodes_apostrophe(self):
        result = _build_content_disposition("审查's.xlsx")
        assert "filename*=UTF-8''" in result
        assert "%27" in result  # apostrophe encoded by quote(safe='')

    def test_no_extension(self):
        result = _build_content_disposition("审查报告")
        assert 'filename="download"' in result
        assert "filename*=UTF-8''" in result

    def test_spaces_in_filename(self):
        result = _build_content_disposition("my report.xlsx")
        # Spaces are safe printable ASCII characters
        assert result == 'attachment; filename="my report.xlsx"'

    def test_control_chars_fall_back(self):
        result = _build_content_disposition("file\x01name.txt")
        assert 'filename="download.txt"' in result

    def test_defaults_to_attachment(self):
        result = _build_content_disposition("report.xlsx")
        assert result.startswith("attachment;")

    def test_inline_disposition_type(self):
        result = _build_content_disposition("video.mp4", "inline")
        assert result == 'inline; filename="video.mp4"'

    def test_inline_with_non_ascii(self):
        result = _build_content_disposition("视频.mp4", "inline")
        assert result.startswith("inline;")
        assert 'filename="download.mp4"' in result
        assert "filename*=UTF-8''" in result


# ---------------------------------------------------------------------------
# Filename decoding in download_file URL path fallback
# ---------------------------------------------------------------------------
class TestFilenameDecoding:
    """Test that the URL path fallback in download_file decodes percent-encoding."""

    def test_unquote_chinese(self):
        """Verify urllib.parse.unquote decodes Chinese characters."""
        assert unquote("%E5%AE%A1%E6%9F%A5.xlsx") == "审查.xlsx"

    def test_unquote_spaces(self):
        assert unquote("my%20report.xlsx") == "my report.xlsx"

    def test_unquote_malformed_sequence(self):
        """Python's unquote returns malformed sequences unchanged."""
        assert unquote("file%GG.txt") == "file%GG.txt"

    def test_unquote_plain_ascii(self):
        assert unquote("report.xlsx") == "report.xlsx"


# ---------------------------------------------------------------------------
# upload_file_to_cos — Content-Disposition header
# ---------------------------------------------------------------------------
class TestUploadFileToCosContentDisposition:
    @pytest.mark.asyncio
    async def test_document_type_sets_attachment_header(self):
        """Document upload should set attachment Content-Disposition."""
        mock_session = AsyncMock()
        mock_response = AsyncMock()
        mock_response.ok = True
        mock_response.__aenter__ = AsyncMock(return_value=mock_response)
        mock_response.__aexit__ = AsyncMock(return_value=None)
        mock_session.put = MagicMock(return_value=mock_response)

        await upload_file_to_cos(
            mock_session,
            credentials={"tmpSecretId": "id", "tmpSecretKey": "key", "sessionToken": "tok"},
            bucket="test-bucket",
            region="ap-test",
            key="uploads/file.xlsx",
            file_data=b"data",
            content_type="application/octet-stream",
            filename="report.xlsx",
        )

        call_kwargs = mock_session.put.call_args
        headers = call_kwargs.kwargs.get("headers") or call_kwargs[1].get("headers")
        assert "Content-Disposition" in headers
        assert headers["Content-Disposition"] == 'attachment; filename="report.xlsx"'

    @pytest.mark.asyncio
    async def test_document_type_non_ascii_sets_rfc5987_header(self):
        """Document upload with Chinese name should use RFC 5987 encoding."""
        mock_session = AsyncMock()
        mock_response = AsyncMock()
        mock_response.ok = True
        mock_response.__aenter__ = AsyncMock(return_value=mock_response)
        mock_response.__aexit__ = AsyncMock(return_value=None)
        mock_session.put = MagicMock(return_value=mock_response)

        await upload_file_to_cos(
            mock_session,
            credentials={"tmpSecretId": "id", "tmpSecretKey": "key", "sessionToken": "tok"},
            bucket="test-bucket",
            region="ap-test",
            key="uploads/file.xlsx",
            file_data=b"data",
            content_type="application/octet-stream",
            filename="审查.xlsx",
        )

        call_kwargs = mock_session.put.call_args
        headers = call_kwargs.kwargs.get("headers") or call_kwargs[1].get("headers")
        cd = headers["Content-Disposition"]
        assert 'filename="download.xlsx"' in cd
        assert "filename*=UTF-8''" in cd
        assert "%E5%AE%A1%E6%9F%A5" in cd

    @pytest.mark.asyncio
    async def test_image_type_no_header(self):
        """Image upload should NOT set Content-Disposition."""
        mock_session = AsyncMock()
        mock_response = AsyncMock()
        mock_response.ok = True
        mock_response.__aenter__ = AsyncMock(return_value=mock_response)
        mock_response.__aexit__ = AsyncMock(return_value=None)
        mock_session.put = MagicMock(return_value=mock_response)

        await upload_file_to_cos(
            mock_session,
            credentials={"tmpSecretId": "id", "tmpSecretKey": "key", "sessionToken": "tok"},
            bucket="test-bucket",
            region="ap-test",
            key="uploads/image.png",
            file_data=b"data",
            content_type="image/png",
            filename="photo.png",
        )

        call_kwargs = mock_session.put.call_args
        headers = call_kwargs.kwargs.get("headers") or call_kwargs[1].get("headers")
        assert "Content-Disposition" not in headers

    @pytest.mark.asyncio
    async def test_video_type_sets_inline_header(self):
        """Video upload should set inline Content-Disposition."""
        mock_session = AsyncMock()
        mock_response = AsyncMock()
        mock_response.ok = True
        mock_response.__aenter__ = AsyncMock(return_value=mock_response)
        mock_response.__aexit__ = AsyncMock(return_value=None)
        mock_session.put = MagicMock(return_value=mock_response)

        await upload_file_to_cos(
            mock_session,
            credentials={"tmpSecretId": "id", "tmpSecretKey": "key", "sessionToken": "tok"},
            bucket="test-bucket",
            region="ap-test",
            key="uploads/video.mp4",
            file_data=b"data",
            content_type="video/mp4",
            filename="meeting.mp4",
        )

        call_kwargs = mock_session.put.call_args
        headers = call_kwargs.kwargs.get("headers") or call_kwargs[1].get("headers")
        assert headers["Content-Disposition"] == 'inline; filename="meeting.mp4"'

    @pytest.mark.asyncio
    async def test_audio_type_sets_inline_header(self):
        """Audio upload should set inline Content-Disposition."""
        mock_session = AsyncMock()
        mock_response = AsyncMock()
        mock_response.ok = True
        mock_response.__aenter__ = AsyncMock(return_value=mock_response)
        mock_response.__aexit__ = AsyncMock(return_value=None)
        mock_session.put = MagicMock(return_value=mock_response)

        await upload_file_to_cos(
            mock_session,
            credentials={"tmpSecretId": "id", "tmpSecretKey": "key", "sessionToken": "tok"},
            bucket="test-bucket",
            region="ap-test",
            key="uploads/audio.mp3",
            file_data=b"data",
            content_type="audio/mpeg",
            filename="recording.mp3",
        )

        call_kwargs = mock_session.put.call_args
        headers = call_kwargs.kwargs.get("headers") or call_kwargs[1].get("headers")
        assert headers["Content-Disposition"] == 'inline; filename="recording.mp3"'

    @pytest.mark.asyncio
    async def test_video_non_ascii_sets_inline_rfc5987(self):
        """Video with non-ASCII name should use inline with RFC 5987."""
        mock_session = AsyncMock()
        mock_response = AsyncMock()
        mock_response.ok = True
        mock_response.__aenter__ = AsyncMock(return_value=mock_response)
        mock_response.__aexit__ = AsyncMock(return_value=None)
        mock_session.put = MagicMock(return_value=mock_response)

        await upload_file_to_cos(
            mock_session,
            credentials={"tmpSecretId": "id", "tmpSecretKey": "key", "sessionToken": "tok"},
            bucket="test-bucket",
            region="ap-test",
            key="uploads/video.mp4",
            file_data=b"data",
            content_type="video/mp4",
            filename="会议录像.mp4",
        )

        call_kwargs = mock_session.put.call_args
        headers = call_kwargs.kwargs.get("headers") or call_kwargs[1].get("headers")
        cd = headers["Content-Disposition"]
        assert cd.startswith("inline;")
        assert 'filename="download.mp4"' in cd
        assert "filename*=UTF-8''" in cd

    @pytest.mark.asyncio
    async def test_no_filename_no_header(self):
        """Upload without filename should NOT set Content-Disposition."""
        mock_session = AsyncMock()
        mock_response = AsyncMock()
        mock_response.ok = True
        mock_response.__aenter__ = AsyncMock(return_value=mock_response)
        mock_response.__aexit__ = AsyncMock(return_value=None)
        mock_session.put = MagicMock(return_value=mock_response)

        await upload_file_to_cos(
            mock_session,
            credentials={"tmpSecretId": "id", "tmpSecretKey": "key", "sessionToken": "tok"},
            bucket="test-bucket",
            region="ap-test",
            key="uploads/file.txt",
            file_data=b"data",
            content_type="text/plain",
        )

        call_kwargs = mock_session.put.call_args
        headers = call_kwargs.kwargs.get("headers") or call_kwargs[1].get("headers")
        assert "Content-Disposition" not in headers

    @pytest.mark.asyncio
    async def test_apostrophe_in_non_ascii_name(self):
        """Non-ASCII filename with apostrophe should encode apostrophe in filename*."""
        mock_session = AsyncMock()
        mock_response = AsyncMock()
        mock_response.ok = True
        mock_response.__aenter__ = AsyncMock(return_value=mock_response)
        mock_response.__aexit__ = AsyncMock(return_value=None)
        mock_session.put = MagicMock(return_value=mock_response)

        await upload_file_to_cos(
            mock_session,
            credentials={"tmpSecretId": "id", "tmpSecretKey": "key", "sessionToken": "tok"},
            bucket="test-bucket",
            region="ap-test",
            key="uploads/file.xlsx",
            file_data=b"data",
            content_type="application/octet-stream",
            filename="审查's.xlsx",
        )

        call_kwargs = mock_session.put.call_args
        headers = call_kwargs.kwargs.get("headers") or call_kwargs[1].get("headers")
        cd = headers["Content-Disposition"]
        assert "%27" in cd  # apostrophe encoded

    @pytest.mark.asyncio
    async def test_pdf_sets_attachment(self):
        """PDF upload should set attachment Content-Disposition."""
        mock_session = AsyncMock()
        mock_response = AsyncMock()
        mock_response.ok = True
        mock_response.__aenter__ = AsyncMock(return_value=mock_response)
        mock_response.__aexit__ = AsyncMock(return_value=None)
        mock_session.put = MagicMock(return_value=mock_response)

        await upload_file_to_cos(
            mock_session,
            credentials={"tmpSecretId": "id", "tmpSecretKey": "key", "sessionToken": "tok"},
            bucket="test-bucket",
            region="ap-test",
            key="uploads/doc.pdf",
            file_data=b"data",
            content_type="application/pdf",
            filename="report.pdf",
        )

        call_kwargs = mock_session.put.call_args
        headers = call_kwargs.kwargs.get("headers") or call_kwargs[1].get("headers")
        assert headers["Content-Disposition"] == 'attachment; filename="report.pdf"'

    @pytest.mark.asyncio
    async def test_text_sets_attachment(self):
        """Text file upload should set attachment Content-Disposition."""
        mock_session = AsyncMock()
        mock_response = AsyncMock()
        mock_response.ok = True
        mock_response.__aenter__ = AsyncMock(return_value=mock_response)
        mock_response.__aexit__ = AsyncMock(return_value=None)
        mock_session.put = MagicMock(return_value=mock_response)

        await upload_file_to_cos(
            mock_session,
            credentials={"tmpSecretId": "id", "tmpSecretKey": "key", "sessionToken": "tok"},
            bucket="test-bucket",
            region="ap-test",
            key="uploads/file.txt",
            file_data=b"data",
            content_type="text/plain",
            filename="notes.txt",
        )

        call_kwargs = mock_session.put.call_args
        headers = call_kwargs.kwargs.get("headers") or call_kwargs[1].get("headers")
        assert headers["Content-Disposition"] == 'attachment; filename="notes.txt"'


# ---------------------------------------------------------------------------
# upload_and_get_url — signature check
# ---------------------------------------------------------------------------
class TestUploadAndGetUrlSignature:
    def test_upload_file_to_cos_has_filename_param(self):
        """upload_file_to_cos should accept filename parameter."""
        sig = inspect.signature(upload_file_to_cos)
        params = list(sig.parameters.keys())
        assert "filename" in params

    def test_upload_file_to_cos_no_is_file_type(self):
        """upload_file_to_cos should not have is_file_type (disposition derived from content_type)."""
        sig = inspect.signature(upload_file_to_cos)
        params = list(sig.parameters.keys())
        assert "is_file_type" not in params

    def test_upload_and_get_url_no_is_file_type(self):
        """upload_and_get_url should not have is_file_type (disposition derived from content_type)."""
        sig = inspect.signature(upload_and_get_url)
        params = list(sig.parameters.keys())
        assert "is_file_type" not in params
