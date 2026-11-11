#!/bin/sh
set -eu
# /src contains upstream 0.95 plus Debian 0.95-6 quilt series; no network.
cd /src
./configure --disable-wordview --with-input=cp1252 --with-output=utf-8 > configure-r34.log
make -C src -j2 > build-r34.log 2>&1
gcc -O2 -DHAVE_CONFIG_H -Isrc /guard/ole-safety.c src/ole.o src/numutils.o -o src/ole-safety
strip src/catdoc src/xls2csv src/catppt src/ole-safety
mkdir -p /out/bin /out/charsets
cp src/catdoc src/xls2csv src/catppt src/ole-safety /out/bin/
cp charsets/*.txt charsets/*.spc charsets/*.rpl /out/charsets/
for file in charsets/*.spc; do cp "$file" "/out/charsets/$(basename "$file" .spc).specchars"; done
for file in charsets/*.rpl; do cp "$file" "/out/charsets/$(basename "$file" .rpl).replchars"; done
cp COPYING /out/LICENSE
