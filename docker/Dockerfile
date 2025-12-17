# Dockerfile for Postgres with electric_poc extension
# Using a multi-stage approach to minimize layer issues
FROM postgres:16 AS builder

# Install build dependencies in one layer
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        build-essential \
        postgresql-server-dev-16 \
    && rm -rf /var/lib/apt/lists/*

# Copy extension source
COPY ext/electric_poc /tmp/electric_poc

# Build the extension
WORKDIR /tmp/electric_poc
RUN make && make install

# Final image - just use the builder stage with extension installed
# This avoids issues with layer deletion/purging
FROM builder AS runtime

# Clean up source files but keep build tools (simpler)
RUN rm -rf /tmp/electric_poc

# Reset working directory
WORKDIR /

# The extension is now installed and can be loaded with:
# CREATE EXTENSION electric_poc;
