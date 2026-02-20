import {
    Body,
    Container,
    Head,
    Heading,
    Html,
    Link,
    Preview,
    Text,
} from "@react-email/components";
import * as React from "react";

interface DocumentEmailProps {
    subject: string;
    message?: string;
    documentName: string;
}

export const DocumentEmail = ({
    subject,
    message,
    documentName,
}: DocumentEmailProps) => (
    <Html>
        <Head />
        <Preview>{subject}</Preview>
        <Body style={main}>
            <Container style={container}>
                <Heading style={h1}>Freezer Chef Document</Heading>
                <Text style={text}>
                    Please find the attached document: <strong>{documentName}</strong>
                </Text>

                {message && (
                    <Text style={text}>
                        {message}
                    </Text>
                )}

                <Text style={footer}>
                    Sent via FreezerIQ
                </Text>
            </Container>
        </Body>
    </Html>
);

export default DocumentEmail;

const main = {
    backgroundColor: "#ffffff",
    fontFamily: '-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Oxygen-Sans,Ubuntu,Cantarell,"Helvetica Neue",sans-serif',
};

const container = {
    margin: "0 auto",
    padding: "20px 0 48px",
    maxWidth: "580px",
};

const h1 = {
    color: "#333",
    fontSize: "24px",
    fontWeight: "bold",
    paddingTop: "32px",
    paddingBottom: "16px",
};

const text = {
    color: "#333",
    fontSize: "16px",
    lineHeight: "26px",
};

const footer = {
    color: "#898989",
    fontSize: "14px",
    marginTop: "32px",
};
