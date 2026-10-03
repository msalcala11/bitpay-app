#!/system/bin/sh
# Included only when the explicit rkStorageFaultJni test-build property is set.
rk_test_lib_dir=$(dirname "$0")
export LD_PRELOAD="$rk_test_lib_dir/librkstorage_faults.so"
exec "$@"
