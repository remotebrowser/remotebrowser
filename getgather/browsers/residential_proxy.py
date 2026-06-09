from typing import Self

from geoip2.errors import GeoIP2Error
from geoip2.webservice import AsyncClient
from pydantic import BaseModel, model_validator

_SKIP_IPS = {"127.0.0.1", "::1", "localhost", "unknown"}


class MassiveLocation(BaseModel):
    """Location information for Massive proxy configuration.

    Validation rules:
    - Country: Must be 2-char ISO code, normalized to lowercase
    - Subdivision: Normalized to lowercase with underscores, validated for US
    - Non-US countries: postal_code and subdivision raise ValueError
    """

    country: str | None = None
    subdivision: str | None = None
    city: str | None = None
    city_compacted: str | None = None
    postal_code: str | None = None

    @model_validator(mode="after")
    def validate_and_normalize(self) -> Self:
        self.country = (str(self.country) if self.country else "").lower().strip()
        self.subdivision = (
            (str(self.subdivision) if self.subdivision else "").lower().strip().replace(" ", "_")
        )
        self.city = (str(self.city) if self.city else "").lower().strip().replace(" ", "_")
        self.postal_code = str(self.postal_code) if self.postal_code else None

        if not self.country or len(self.country) != 2 or not self.country.isalpha():
            raise ValueError(
                f"Invalid country code: '{self.country}'. Must be a 2-character ISO country code (e.g., 'us', 'uk')"
            )

        if self.country != "us":
            if self.postal_code:
                raise ValueError(
                    f"postal_code not supported for non-US (country: '{self.country}')"
                )
            if self.subdivision:
                raise ValueError(
                    f"subdivision not supported for non-US (country: '{self.country}')"
                )

        if self.city:
            self.city_compacted = (
                self.city.lower().replace("-", "").replace("_", "").replace(" ", "")
            )

        return self


class MassiveProxy:
    @staticmethod
    async def get_location(
        ip: str,
        account_id: int,
        license_key: str,
    ) -> "MassiveLocation | None":
        """Look up geolocation for an IP via MaxMind GeoIP2 City web service.

        Returns a MassiveLocation or None if the IP is local/unknown or lookup fails.
        """
        if not ip or ip in _SKIP_IPS:
            return None

        async with AsyncClient(account_id, license_key) as client:
            try:
                response = await client.city(ip)
            except GeoIP2Error:
                return None

        country = response.country.iso_code  # e.g. "US"
        subdivision = response.subdivisions.most_specific.iso_code  # e.g. "CA"
        city = response.city.name
        postal_code = response.postal.code

        try:
            return MassiveLocation(
                country=country,
                subdivision=subdivision,
                city=city,
                postal_code=postal_code,
            )
        except ValueError:
            return None

    @staticmethod
    def format_url(
        location: "MassiveLocation",
        session_id: str,
        username: str,
        password: str,
    ) -> str:
        """Format a Massive residential proxy URL from a location.

        Returns:
            Formatted proxy URL.
        """
        username_template = f"{username}"
        if location.country:
            username_template += f"-country-{location.country}"
        if (
            location.subdivision and len(location.subdivision) == 2
        ):  # only add subdivision if it's a valid 2-letter code (currently only supporting US subdivisions)
            username_template += f"-subdivision-{location.subdivision.upper()}"
        elif location.postal_code:  # don't want to unnecessarily constrain the pool size by adding postal code if subdivision is already specified
            username_template += f"-zipcode-{location.postal_code}"
        # max ttl is 240 mins: https://docs.joinmassive.com/residential/sticky-sessions
        return f"http://{username_template}-session-{session_id}-sessionttl-240:{password}@network.joinmassive.com:65534"
