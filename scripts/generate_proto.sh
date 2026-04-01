#!/bin/bash

# Protocol Buffer Code Generation Script
# Generates Python, TypeScript, and Rust code from .proto files

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
PROTO_DIR="$PROJECT_ROOT/proto"
OUTPUT_DIR="$PROJECT_ROOT/generated"

echo "=== Protocol Buffer Code Generation ==="
echo "Proto directory: $PROTO_DIR"
echo "Output directory: $OUTPUT_DIR"
echo ""

# Create output directories
mkdir -p "$OUTPUT_DIR/python"
mkdir -p "$OUTPUT_DIR/typescript"
mkdir -p "$OUTPUT_DIR/rust"

# Check if protoc is installed
if ! command -v protoc &> /dev/null; then
    echo "Error: protoc is not installed"
    echo "Install with: apt-get install -y protobuf-compiler"
    exit 1
fi

# Check if python grpc plugins are installed
if ! python3 -c "import grpc_tools.protoc" 2>/dev/null; then
    echo "Installing Python grpc tools..."
    pip install grpcio-tools
fi

# Generate Python code
echo "Generating Python code..."
python3 -m grpc_tools.protoc \
    --proto_path="$PROTO_DIR" \
    --python_out="$OUTPUT_DIR/python" \
    --grpc_python_out="$OUTPUT_DIR/python" \
    "$PROTO_DIR"/*.proto

echo "Python code generated to $OUTPUT_DIR/python"

# Generate TypeScript code
if command -v protoc-gen-ts &> /dev/null; then
    echo "Generating TypeScript code..."
    protoc \
        --proto_path="$PROTO_DIR" \
        --plugin=protoc-gen-ts \
        --ts_out="$OUTPUT_DIR/typescript" \
        "$PROTO_DIR"/*.proto

    echo "TypeScript code generated to $OUTPUT_DIR/typescript"
else
    echo "Warning: protoc-gen-ts not installed, skipping TypeScript generation"
    echo "Install with: npm install -g protoc-gen-ts"
fi

# Generate Rust code (uses build.rs, but we can also generate here)
if command -v protoc-gen-rust &> /dev/null; then
    echo "Generating Rust code..."
    protoc \
        --proto_path="$PROTO_DIR" \
        --rust_out="$OUTPUT_DIR/rust" \
        "$PROTO_DIR"/*.proto

    echo "Rust code generated to $OUTPUT_DIR/rust"
else
    echo "Note: Rust code is generated via tonic-build in Rust build.rs"
fi

# Create __init__.py for Python package
touch "$OUTPUT_DIR/python/__init__.py"

echo ""
echo "=== Generation Complete ==="
echo "Files generated in $OUTPUT_DIR"

# List generated files
echo ""
echo "Generated Python files:"
find "$OUTPUT_DIR/python" -name "*.py" | head -20

if [ -d "$OUTPUT_DIR/typescript" ]; then
    echo ""
    echo "Generated TypeScript files:"
    find "$OUTPUT_DIR/typescript" -name "*.ts" | head -20
fi

echo ""
echo "Done!"
