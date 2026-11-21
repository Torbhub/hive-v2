import React from 'react';
import { Box, Text } from 'ink';
import { contractLines, type Need } from './look.js';

export function ContractBlock({ need }: { need: Need }) {
  return (
    <Box flexDirection="column" paddingLeft={2}>
      {contractLines(need).map((line, index) => (
        <Text key={index} color={index === 0 ? 'white' : 'gray'} bold={index === 0}>{line}</Text>
      ))}
    </Box>
  );
}
