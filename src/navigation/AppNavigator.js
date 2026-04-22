import React from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { Text } from 'react-native';
import { ChatScreen }     from '../screens/ChatScreen';
import { SettingsScreen } from '../screens/SettingsScreen';
import { colors } from '../config/theme';

const Tab = createBottomTabNavigator();

const icon = (label) => ({ focused }) => (
  <Text style={{ fontSize: 18, opacity: focused ? 1 : 0.4 }}>
    {label === 'Chat' ? '◈' : '⚙'}
  </Text>
);

export function AppNavigator() {
  return (
    <NavigationContainer>
      <Tab.Navigator
        screenOptions={{
          headerShown:        false,
          tabBarStyle: {
            backgroundColor: colors.bg1,
            borderTopColor:  colors.border,
            borderTopWidth:  1,
            height:          58,
            paddingBottom:   8,
          },
          tabBarActiveTintColor:   colors.accent,
          tabBarInactiveTintColor: colors.text3,
          tabBarLabelStyle:   { fontFamily: 'Courier New', fontSize: 11 },
        }}
      >
        <Tab.Screen name="Chat"     component={ChatScreen}     options={{ tabBarIcon: icon('Chat') }} />
        <Tab.Screen name="Settings" component={SettingsScreen} options={{ tabBarIcon: icon('Settings') }} />
      </Tab.Navigator>
    </NavigationContainer>
  );
}