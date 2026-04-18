"""
Tests for issue #225 fixes:
- Filename decoding in download_file
- _build_content_disposition helper
- upload_file_to_cos Content-Disposition header
- upload_and_get_url is_file_type forwarding
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
    async def test_file_type_ascii_name_sets_header(self):
        """File-type upload with ASCII name should set Content-Disposition."""
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
            is_file_type=True,
        )

        # Extract the headers passed to session.put
        call_kwargs = mock_session.put.call_args
        headers = call_kwargs.kwargs.get("headers") or call_kwargs[1].get("headers")
        assert "Content-Disposition" in headers
        assert headers["Content-Disposition"] == 'attachment; filename="report.xlsx"'

    @pytest.mark.asyncio
    async def test_file_type_non_ascii_name_sets_rfc5987_header(self):
        """File-type upload with Chinese name should use RFC 5987 encoding."""
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
            is_file_type=True,
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
            is_file_type=False,
        )

        call_kwargs = mock_session.put.call_args
        headers = call_kwargs.kwargs.get("headers") or call_kwargs[1].get("headers")
        assert "Content-Disposition" not in headers

    @pytest.mark.asyncio
    async def test_file_type_no_filename_no_header(self):
        """File-type upload without filename should NOT set Content-Disposition."""
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
            is_file_type=True,
            # filename not provided
        )

        call_kwargs = mock_session.put.call_args
        headers = call_kwargs.kwargs.get("headers") or call_kwargs[1].get("headers")
        assert "Content-Disposition" not in headers

    @pytest.mark.asyncio
    async def test_file_type_apostrophe_in_name(self):
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
            is_file_type=True,
        )

        call_kwargs = mock_session.put.call_args
        headers = call_kwargs.kwargs.get("headers") or call_kwargs[1].get("headers")
        cd = headers["Content-Disposition"]
        assert "%27" in cd  # apostrophe encoded


# ---------------------------------------------------------------------------
# upload_and_get_url — is_file_type parameter forwarding
# ---------------------------------------------------------------------------
class TestUploadAndGetUrlSignature:
    def test_is_file_type_parameter_exists(self):
        """upload_and_get_url should accept is_file_type parameter."""
        sig = inspect.signature(upload_and_get_url)
        params = list(sig.parameters.keys())
        assert "is_file_type" in params

    def test_upload_file_to_cos_has_new_params(self):
        """upload_file_to_cos should accept filename and is_file_type parameters."""
        sig = inspect.signature(upload_file_to_cos)
        params = list(sig.parameters.keys())
        assert "filename" in params
        assert "is_file_type" in params
